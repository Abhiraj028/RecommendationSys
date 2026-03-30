import { Router } from "express";

import { fetchMoviesByIds, fetchPopularMovies, searchMovies } from "../db/movies.js";
import type { MovieSummary } from "../types/api.js";

export const moviesRouter = Router();

const TMDB_SEARCH_URL = "https://api.themoviedb.org/3/search/movie";

const parseTitleYear = (raw: string): { title: string; year?: number } => {
  const match = raw.match(/\((\d{4})\)\s*$/);
  if (match) {
    return { title: raw.replace(/\s*\(\d{4}\)\s*$/, "").trim(), year: Number(match[1]) };
  }
  return { title: raw };
};

const normalizeTitle = (title: string) => title.replace(/\s+/g, " ").trim();

const reorderArticle = (title: string) => {
  if (/^.+,\sThe$/i.test(title)) {
    return `The ${title.replace(/,\sThe$/i, "").trim()}`;
  }
  if (/^.+,\sA$/i.test(title)) {
    return `A ${title.replace(/,\sA$/i, "").trim()}`;
  }
  if (/^.+,\sAn$/i.test(title)) {
    return `An ${title.replace(/,\sAn$/i, "").trim()}`;
  }
  return title;
};

const stripSubtitle = (title: string) => {
  const parts = title.split(":");
  return parts[0]?.trim() || title;
};

const parseIds = (value: string | string[] | undefined): number[] => {
  if (!value) {
    return [];
  }

  const raw = Array.isArray(value) ? value.join(",") : value;
  return raw
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id));
};

const buildPosterUrl = (posterPath: string | null) => {
  if (!posterPath) {
    return null;
  }

  const base = process.env.MOVIE_IMAGE_BASE_URL || "";
  return `${base}${posterPath}`;
};

const mapSummary = (
  row: {
    movie_id: number;
    title: string;
    genres: string[];
  },
  posterPath?: string | null
): MovieSummary => ({
  movieId: row.movie_id,
  title: row.title,
  genres: row.genres,
  posterUrl: buildPosterUrl(posterPath ?? null),
  thumbnailUrl: buildPosterUrl(posterPath ?? null),
});

const fetchPosterPath = async (title: string): Promise<string | null> => {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    return null;
  }

  const { title: cleanTitle, year } = parseTitleYear(title);
  const primary = normalizeTitle(cleanTitle);
  const alternates = [
    stripSubtitle(primary),
    reorderArticle(primary),
    reorderArticle(stripSubtitle(primary)),
  ];
  const queries = Array.from(new Set([primary, ...alternates].filter(Boolean)));

  try {
    for (const [index, query] of queries.entries()) {
      const params = new URLSearchParams({ api_key: apiKey, query });
      if (year && index === 0) {
        params.set("year", String(year));
      }
      const response = await fetch(`${TMDB_SEARCH_URL}?${params.toString()}`);
      if (!response.ok) {
        continue;
      }

      const data = (await response.json()) as { results?: Array<{ poster_path?: string | null }> };
      const posterPath = data.results?.[0]?.poster_path ?? null;
      if (posterPath) {
        return posterPath;
      }
    }
    return null;
  } catch {
    return null;
  }
};

moviesRouter.get("/", async (req, res) => {
  try {
    const ids = parseIds(req.query.ids);
    const rows = await fetchMoviesByIds(ids);
    const items = await Promise.all(
      rows.map(async (row) => mapSummary(row, await fetchPosterPath(row.title)))
    );
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

moviesRouter.get("/popular", async (req, res) => {
  const limit = Number(req.query.limit ?? 50);

  try {
    const rows = await fetchPopularMovies(limit);
    const items = await Promise.all(
      rows.map(async (row) => mapSummary(row, await fetchPosterPath(row.title)))
    );
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

moviesRouter.get("/search", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  const limit = Number(req.query.limit ?? 25);

  if (!query) {
    res.json({ items: [] });
    return;
  }

  try {
    const rows = await searchMovies(query, limit);
    const items = await Promise.all(
      rows.map(async (row) => mapSummary(row, await fetchPosterPath(row.title)))
    );
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
