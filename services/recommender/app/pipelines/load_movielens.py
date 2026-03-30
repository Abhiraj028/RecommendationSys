import os
import tempfile
import zipfile
from datetime import datetime, timezone

import pandas as pd
import psycopg2
import requests


def _read_dat(path: str, names: list[str]) -> pd.DataFrame:
    return pd.read_csv(path, sep="::", names=names, engine="python", encoding="latin-1")


def _to_pg_array(values: list[str]) -> str:
    escaped = [value.replace("\\", "\\\\").replace('"', '\\"') for value in values]
    return "{" + ",".join(escaped) + "}"


def _extract_zip(zip_path: str, target_dir: str) -> str:
    with zipfile.ZipFile(zip_path, "r") as zip_ref:
        zip_ref.extractall(target_dir)
        top_level = {name.split("/")[0] for name in zip_ref.namelist() if "/" in name}
    if not top_level:
        raise RuntimeError("Could not detect extracted dataset directory")
    return os.path.join(target_dir, sorted(top_level)[0])


def _download_zip(url: str, dest_path: str) -> None:
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with requests.get(url, stream=True, timeout=60) as response:
        response.raise_for_status()
        with open(dest_path, "wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)


def _load_schema(conn, schema_path: str) -> None:
    with open(schema_path, "r", encoding="utf-8") as handle:
        conn.cursor().execute(handle.read())
        conn.commit()


def _copy_dataframe(conn, df: pd.DataFrame, table: str, columns: list[str]) -> None:
    with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".csv") as temp:
        df.to_csv(temp.name, index=False, header=False)
        temp_path = temp.name

    with conn.cursor() as cursor:
        with open(temp_path, "r", encoding="utf-8") as handle:
            cursor.copy_expert(
                f"COPY {table} ({', '.join(columns)}) FROM STDIN WITH CSV",
                handle,
            )
        conn.commit()

    os.remove(temp_path)


def _iter_ratings_csv(path: str, chunksize: int) -> pd.io.parsers.TextFileReader:
    return pd.read_csv(path, chunksize=chunksize)


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    dataset = os.environ.get("ML_DATASET", "1m").lower()
    zip_path = os.environ.get("ML_ZIP_PATH") or (
        "/app/ml-latest-small.zip"
        if dataset in {"latest-small", "100k", "small"}
        else ("/app/ml-25m.zip" if dataset in {"25m", "32m"} else "/app/ml-1m.zip")
    )
    zip_url = os.environ.get("ML_ZIP_URL")

    if not database_url:
        raise RuntimeError("DATABASE_URL is required")

    print(f"Loading MovieLens dataset: {dataset}")
    print(f"Zip path: {zip_path}")

    if not os.path.exists(zip_path):
        if zip_url:
            print(f"Downloading dataset from {zip_url}...")
            _download_zip(zip_url, zip_path)
        else:
            raise FileNotFoundError(f"Missing dataset zip at {zip_path}")

    extract_root = tempfile.mkdtemp(prefix="ml1m_")
    data_dir = _extract_zip(zip_path, extract_root)
    print(f"Extracted to: {data_dir}")

    if dataset in {"25m", "32m", "latest-small", "100k", "small"}:
        print("Reading movies.csv")
        movies = pd.read_csv(os.path.join(data_dir, "movies.csv"))
        movies = movies.rename(columns={"movieId": "movie_id"})
        movies["genres"] = movies["genres"].apply(lambda value: _to_pg_array(value.split("|")))

        ratings_path = os.path.join(data_dir, "ratings.csv")
        users = pd.DataFrame({"user_id": []})
        users["gender"] = None
        users["age"] = None
        users["occupation"] = None
        users["zip_code"] = None
    else:
        print("Reading movies.dat")
        movies = _read_dat(
            os.path.join(data_dir, "movies.dat"),
            ["movie_id", "title", "genres"],
        )
        movies["genres"] = movies["genres"].apply(lambda value: _to_pg_array(value.split("|")))

        print("Reading users.dat")
        users = _read_dat(
            os.path.join(data_dir, "users.dat"),
            ["user_id", "gender", "age", "occupation", "zip_code"],
        )

        print("Reading ratings.dat")
        ratings = _read_dat(
            os.path.join(data_dir, "ratings.dat"),
            ["user_id", "movie_id", "rating", "timestamp"],
        )
        ratings["rated_at"] = ratings["timestamp"].apply(
            lambda value: datetime.fromtimestamp(int(value), tz=timezone.utc)
        )
        ratings = ratings.drop(columns=["timestamp"])

    with psycopg2.connect(database_url) as conn:
        schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
        _load_schema(conn, schema_path)

        with conn.cursor() as cursor:
            print("Truncating existing tables")
            cursor.execute("TRUNCATE ratings, users, movies, movie_stats RESTART IDENTITY")
            cursor.execute(
                "ALTER TABLE ratings ALTER COLUMN rating TYPE NUMERIC(3,1) USING rating::numeric"
            )
            conn.commit()

        print("Dropping foreign keys on ratings for faster load")
        with conn.cursor() as cursor:
            cursor.execute("ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_user_id_fkey")
            cursor.execute("ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_movie_id_fkey")
            conn.commit()

        print(f"Copying users: {len(users):,}")
        if len(users):
            _copy_dataframe(conn, users, "users", ["user_id", "gender", "age", "occupation", "zip_code"])
        print(f"Copying movies: {len(movies):,}")
        _copy_dataframe(conn, movies, "movies", ["movie_id", "title", "genres"])

        if dataset in {"25m", "32m", "latest-small", "100k", "small"}:
            print("Copying ratings in chunks")
            ratings_path = os.path.join(data_dir, "ratings.csv")
            total = 0
            for idx, chunk in enumerate(_iter_ratings_csv(ratings_path, chunksize=1_000_000), start=1):
                chunk = chunk.rename(columns={"userId": "user_id", "movieId": "movie_id"})
                chunk["rated_at"] = pd.to_datetime(chunk["timestamp"], unit="s", utc=True)
                chunk = chunk.drop(columns=["timestamp"])
                chunk["rating"] = chunk["rating"].astype(float)
                _copy_dataframe(conn, chunk, "ratings", ["user_id", "movie_id", "rating", "rated_at"])
                total += len(chunk)
                print(f"Ratings chunk {idx}: total {total:,}")

            print("Backfilling users table from ratings")
            with conn.cursor() as cursor:
                cursor.execute("TRUNCATE users")
                cursor.execute(
                    """
                    INSERT INTO users (user_id, gender, age, occupation, zip_code)
                    SELECT DISTINCT user_id, NULL::text, NULL::integer, NULL::integer, NULL::text
                    FROM ratings
                    """
                )
                conn.commit()
        else:
            print(f"Copying ratings: {len(ratings):,}")
            ratings["rating"] = ratings["rating"].astype(float)
            _copy_dataframe(conn, ratings, "ratings", ["user_id", "movie_id", "rating", "rated_at"])

        with conn.cursor() as cursor:
            print("Rebuilding movie_stats")
            cursor.execute(
                """
                INSERT INTO movie_stats (movie_id, rating_count, rating_avg)
                SELECT movie_id, COUNT(*) AS rating_count, AVG(rating)::numeric(4,2) AS rating_avg
                FROM ratings
                GROUP BY movie_id
                """
            )
            conn.commit()

    print("Loader complete.")


if __name__ == "__main__":
    main()
