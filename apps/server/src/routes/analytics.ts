import { Router } from "express";

import { pool } from "../db/pool.js";

export const analyticsRouter = Router();

const ANALYTICS_CACHE_TTL = 1000 * 60 * 5;
let analyticsCache: { data: unknown; expiresAt: number } | null = null;

const buildBuckets = (
  min: number,
  max: number,
  bucketCount: number,
  buckets: Array<{ bucket: number; count: number }>,
  precision: number
) => {
  if (bucketCount <= 0) {
    return [] as Array<{ label: string; count: number }>;
  }

  const map = new Map<number, number>();
  buckets.forEach((row) => {
    map.set(row.bucket, row.count);
  });

  if (min === max) {
    return [
      {
        label: min.toFixed(precision),
        count: buckets.reduce((sum, row) => sum + row.count, 0),
      },
    ];
  }

  const size = (max - min) / bucketCount;
  const labels: Array<{ label: string; count: number }> = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const start = min + index * size;
    const end = min + (index + 1) * size;
    const bucket = index + 1;
    labels.push({
      label: `${start.toFixed(precision)}-${end.toFixed(precision)}`,
      count: map.get(bucket) ?? 0,
    });
  }
  return labels;
};

const toNumber = (value: unknown) => Number(value ?? 0);

const getCountStats = async (column: "user_id" | "movie_id") => {
  const statsResult = await pool.query(
    `
    SELECT MIN(count)::float AS min, MAX(count)::float AS max, AVG(count)::float AS avg
    FROM (
      SELECT COUNT(*)::int AS count
      FROM ratings
      GROUP BY ${column}
    ) counts
    `
  );

  const statsRow = statsResult.rows[0] ?? {};
  const min = toNumber(statsRow.min);
  const max = toNumber(statsRow.max);
  const avg = toNumber(statsRow.avg);

  if (min === 0 && max === 0) {
    return { min, max, avg, bins: [] };
  }

  if (min === max) {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ratings GROUP BY ${column}`
    );
    const total = countResult.rowCount;
    return {
      min,
      max,
      avg,
      bins: [{ label: min.toFixed(0), count: total }],
    };
  }

  const bucketCount = 10;
  const bucketResult = await pool.query(
    `
    SELECT width_bucket(count, $1, $2, $3) AS bucket, COUNT(*)::int AS count
    FROM (
      SELECT COUNT(*)::int AS count
      FROM ratings
      GROUP BY ${column}
    ) counts
    GROUP BY bucket
    ORDER BY bucket
    `,
    [min, max, bucketCount]
  );

  return {
    min,
    max,
    avg,
    bins: buildBuckets(
      min,
      max,
      bucketCount,
      bucketResult.rows.map((row) => ({
        bucket: Number(row.bucket),
        count: Number(row.count),
      })),
      0
    ),
  };
};

const getMeanHistogram = async (column: "user_id" | "movie_id") => {
  const statsResult = await pool.query(
    `
    SELECT MIN(mean)::float AS min, MAX(mean)::float AS max, AVG(mean)::float AS avg
    FROM (
      SELECT AVG(rating)::float AS mean
      FROM ratings
      GROUP BY ${column}
    ) means
    `
  );

  const statsRow = statsResult.rows[0] ?? {};
  const min = toNumber(statsRow.min);
  const max = toNumber(statsRow.max);
  const avg = toNumber(statsRow.avg);

  if (min === 0 && max === 0) {
    return { min, max, avg, bins: [] };
  }

  if (min === max) {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ratings GROUP BY ${column}`
    );
    const total = countResult.rowCount;
    return {
      min,
      max,
      avg,
      bins: [{ label: min.toFixed(2), count: total }],
    };
  }

  const bucketCount = 10;
  const bucketResult = await pool.query(
    `
    SELECT width_bucket(mean, $1, $2, $3) AS bucket, COUNT(*)::int AS count
    FROM (
      SELECT AVG(rating)::float AS mean
      FROM ratings
      GROUP BY ${column}
    ) means
    GROUP BY bucket
    ORDER BY bucket
    `,
    [min, max, bucketCount]
  );

  return {
    min,
    max,
    avg,
    bins: buildBuckets(
      min,
      max,
      bucketCount,
      bucketResult.rows.map((row) => ({
        bucket: Number(row.bucket),
        count: Number(row.count),
      })),
      2
    ),
  };
};

analyticsRouter.get("/overview", async (_req, res) => {
  try {
    if (analyticsCache && analyticsCache.expiresAt > Date.now()) {
      res.json(analyticsCache.data);
      return;
    }

    const [
      countsResult,
      ratingsResult,
      userStats,
      movieStats,
      globalMeanResult,
      tailResult,
      matrixUsersResult,
      matrixMoviesResult,
    ] = await Promise.all([
      pool.query(
        "SELECT (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM movies) AS movies, (SELECT COUNT(*)::int FROM ratings) AS ratings"
      ),
      pool.query(
        "SELECT rating::float AS rating, COUNT(*)::int AS count FROM ratings GROUP BY rating ORDER BY rating"
      ),
      getCountStats("user_id"),
      getCountStats("movie_id"),
      pool.query("SELECT AVG(rating)::float AS mean FROM ratings"),
      pool.query(
        "SELECT COUNT(*)::int AS count FROM ratings GROUP BY movie_id ORDER BY count DESC LIMIT 200"
      ),
      pool.query(
        "SELECT DISTINCT user_id FROM ratings TABLESAMPLE SYSTEM (0.1) LIMIT 30"
      ),
      pool.query(
        "SELECT DISTINCT movie_id FROM ratings TABLESAMPLE SYSTEM (0.1) LIMIT 40"
      ),
    ]);

    const countsRow = countsResult.rows[0] ?? { users: 0, movies: 0, ratings: 0 };
    const userMeanStats = await getMeanHistogram("user_id");
    const movieMeanStats = await getMeanHistogram("movie_id");

    const topResult = await pool.query(
      `
      SELECT m.movie_id AS movie_id, m.title AS title, s.rating_count AS rating_count, s.rating_avg AS rating_avg
      FROM movie_stats s
      JOIN movies m ON m.movie_id = s.movie_id
      ORDER BY s.rating_count DESC, s.rating_avg DESC
      LIMIT 12
      `
    );

    const ratingThreshold = 50;
    const [bestResult, worstResult] = await Promise.all([
      pool.query(
        `
        SELECT m.movie_id AS movie_id, m.title AS title, s.rating_count AS rating_count, s.rating_avg AS rating_avg
        FROM movie_stats s
        JOIN movies m ON m.movie_id = s.movie_id
        WHERE s.rating_count >= $1
        ORDER BY s.rating_avg DESC, s.rating_count DESC
        LIMIT 10
        `,
        [ratingThreshold]
      ),
      pool.query(
        `
        SELECT m.movie_id AS movie_id, m.title AS title, s.rating_count AS rating_count, s.rating_avg AS rating_avg
        FROM movie_stats s
        JOIN movies m ON m.movie_id = s.movie_id
        WHERE s.rating_count >= $1
        ORDER BY s.rating_avg ASC, s.rating_count DESC
        LIMIT 10
        `,
        [ratingThreshold]
      ),
    ]);

    const fallbackThreshold = 10;
    const bestFallback =
      bestResult.rows.length < 10
        ? await pool.query(
            `
            SELECT m.movie_id AS movie_id, m.title AS title, s.rating_count AS rating_count, s.rating_avg AS rating_avg
            FROM movie_stats s
            JOIN movies m ON m.movie_id = s.movie_id
            WHERE s.rating_count >= $1
            ORDER BY s.rating_avg DESC, s.rating_count DESC
            LIMIT 10
            `,
            [fallbackThreshold]
          )
        : null;

    const worstFallback =
      worstResult.rows.length < 10
        ? await pool.query(
            `
            SELECT m.movie_id AS movie_id, m.title AS title, s.rating_count AS rating_count, s.rating_avg AS rating_avg
            FROM movie_stats s
            JOIN movies m ON m.movie_id = s.movie_id
            WHERE s.rating_count >= $1
            ORDER BY s.rating_avg ASC, s.rating_count DESC
            LIMIT 10
            `,
            [fallbackThreshold]
          )
        : null;

    let matrixUserIds = matrixUsersResult.rows.map((row) => Number(row.user_id));
    let matrixMovieIds = matrixMoviesResult.rows.map((row) => Number(row.movie_id));

    if (matrixUserIds.length < 10) {
      const fallbackUsers = await pool.query(
        "SELECT user_id FROM ratings GROUP BY user_id ORDER BY random() LIMIT 30"
      );
      matrixUserIds = fallbackUsers.rows.map((row) => Number(row.user_id));
    }

    if (matrixMovieIds.length < 10) {
      const fallbackMovies = await pool.query(
        "SELECT movie_id FROM ratings GROUP BY movie_id ORDER BY random() LIMIT 40"
      );
      matrixMovieIds = fallbackMovies.rows.map((row) => Number(row.movie_id));
    }

    let sparsityMatrix = {
      rows: matrixUserIds.length,
      cols: matrixMovieIds.length,
      cells: [] as number[],
    };

    if (matrixUserIds.length && matrixMovieIds.length) {
      const ratingsResultMatrix = await pool.query(
        `
        SELECT user_id, movie_id
        FROM ratings
        WHERE user_id = ANY($1) AND movie_id = ANY($2)
        `,
        [matrixUserIds, matrixMovieIds]
      );

      const userIndex = new Map<number, number>();
      matrixUserIds.forEach((id, index) => userIndex.set(id, index));
      const movieIndex = new Map<number, number>();
      matrixMovieIds.forEach((id, index) => movieIndex.set(id, index));

      const cells = new Array(matrixUserIds.length * matrixMovieIds.length).fill(0);
      ratingsResultMatrix.rows.forEach((row) => {
        const r = userIndex.get(Number(row.user_id));
        const c = movieIndex.get(Number(row.movie_id));
        if (r != null && c != null) {
          cells[r * matrixMovieIds.length + c] = 1;
        }
      });

      sparsityMatrix = {
        rows: matrixUserIds.length,
        cols: matrixMovieIds.length,
        cells,
      };
    }

    const users = toNumber(countsRow.users);
    const movies = toNumber(countsRow.movies);
    const ratings = toNumber(countsRow.ratings);
    const totalCells = users * movies;
    const sparsity = totalCells ? 1 - ratings / totalCells : 0;
    const missing = Math.max(0, totalCells - ratings);

    const payload = {
      counts: { users, movies, ratings },
      ratingDistribution: ratingsResult.rows.map((row) => ({
        label: Number(row.rating) % 1 === 0 ? Number(row.rating).toFixed(0) : Number(row.rating).toFixed(1),
        count: Number(row.count),
      })),
      ratingsPerUser: {
        min: userStats.min,
        avg: userStats.avg,
        max: userStats.max,
        bins: userStats.bins,
      },
      ratingsPerMovie: {
        min: movieStats.min,
        avg: movieStats.avg,
        max: movieStats.max,
        bins: movieStats.bins,
      },
      moviePopularity: {
        tail: tailResult.rows.map((row) => Number(row.count)),
        top: topResult.rows.map((row) => ({
          movieId: Number(row.movie_id),
          title: String(row.title),
          ratingCount: Number(row.rating_count),
          ratingAvg: Number(row.rating_avg),
        })),
        topRated: (bestFallback?.rows ?? bestResult.rows).map((row) => ({
          movieId: Number(row.movie_id),
          title: String(row.title),
          ratingCount: Number(row.rating_count),
          ratingAvg: Number(row.rating_avg),
        })),
        worstRated: (worstFallback?.rows ?? worstResult.rows).map((row) => ({
          movieId: Number(row.movie_id),
          title: String(row.title),
          ratingCount: Number(row.rating_count),
          ratingAvg: Number(row.rating_avg),
        })),
      },
      sparsity,
      sparsityChart: [
        { label: "Rated", count: ratings },
        { label: "Missing", count: missing },
      ],
      sparsityMatrix,
      ratingThreshold,
      bias: {
        globalMean: toNumber(globalMeanResult.rows[0]?.mean),
        userMin: userMeanStats.min,
        userMax: userMeanStats.max,
        movieMin: movieMeanStats.min,
        movieMax: movieMeanStats.max,
        userBins: userMeanStats.bins,
        movieBins: movieMeanStats.bins,
      },
    };

    analyticsCache = { data: payload, expiresAt: Date.now() + ANALYTICS_CACHE_TTL };
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
