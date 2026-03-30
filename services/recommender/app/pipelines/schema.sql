CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  gender TEXT,
  age INTEGER,
  occupation INTEGER,
  zip_code TEXT
);

CREATE TABLE IF NOT EXISTS movies (
  movie_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  genres TEXT[] NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  user_id INTEGER NOT NULL,
  movie_id INTEGER NOT NULL,
  rating NUMERIC(3,1) NOT NULL,
  rated_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS ratings_user_idx ON ratings(user_id);
CREATE INDEX IF NOT EXISTS ratings_movie_idx ON ratings(movie_id);

CREATE TABLE IF NOT EXISTS movie_stats (
  movie_id INTEGER PRIMARY KEY REFERENCES movies(movie_id),
  rating_count INTEGER NOT NULL,
  rating_avg NUMERIC(4,2) NOT NULL
);

