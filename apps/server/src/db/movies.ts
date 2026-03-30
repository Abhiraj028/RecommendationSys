import { pool } from "./pool.js";

export type MovieRow = {
  movie_id: number;
  title: string;
  genres: string[];
};

export const fetchMoviesByIds = async (ids: number[]) => {
  if (!ids.length) {
    return [] as MovieRow[];
  }

  const result = await pool.query(
    `
    SELECT m.movie_id, m.title, m.genres
    FROM movies m
    WHERE m.movie_id = ANY($1)
    `,
    [ids]
  );

  return result.rows as MovieRow[];
};

export const fetchPopularMovies = async (limit: number) => {
  const result = await pool.query(
    `
    SELECT m.movie_id, m.title, m.genres
    FROM movie_stats s
    JOIN movies m ON m.movie_id = s.movie_id
    ORDER BY s.rating_count DESC, s.rating_avg DESC
    LIMIT $1
    `,
    [limit]
  );

  return result.rows as MovieRow[];
};

export const fetchPopularMovieIds = async (limit: number) => {
  const result = await pool.query(
    "SELECT movie_id FROM movie_stats ORDER BY rating_count DESC, rating_avg DESC LIMIT $1",
    [limit]
  );

  return result.rows.map((row) => row.movie_id as number);
};

export const searchMovies = async (query: string, limit: number) => {
  const result = await pool.query(
    `
    SELECT m.movie_id, m.title, m.genres
    FROM movies m
    WHERE LOWER(m.title) LIKE LOWER($1)
    ORDER BY m.title
    LIMIT $2
    `,
    [`%${query}%`, limit]
  );

  return result.rows as MovieRow[];
};
