import { Router } from "express";

import {
  fetchMovieById,
  fetchMoviesByIds,
  fetchPopularMovies,
  searchMovies,
} from "../db/movies.js";
import type { MovieSummary } from "../types/api.js";

export const moviesRouter = Router();

const TMDB_SEARCH_URL = "https://api.themoviedb.org/3/search/movie";
const TMDB_REVIEWS_URL = "https://api.themoviedb.org/3/movie";
const TMDB_CACHE_TTL = 1000 * 60 * 60 * 24;

type TmdbMatch = {
  tmdbId: number;
  posterPath: string | null;
  overview?: string | null;
  releaseDate?: string | null;
  voteAverage?: number | null;
  voteCount?: number | null;
  backdropPath?: string | null;
};

const tmdbCache = new Map<string, { data: TmdbMatch | null; expiresAt: number }>();

const parseTitleYear = (raw: string): { title: string; year?: number } => {
  const match = raw.match(/\((\d{4})\)\s*$/);
  if (match) {
    return { title: raw.replace(/\s*\(\d{4}\)\s*$/, "").trim(), year: Number(match[1]) };
  }
  return { title: raw };
};

const normalizeTitle = (title: string) => title.replace(/\s+/g, " ").trim();

const collapseSpaces = (value: string) => value.replace(/\s+/g, " ").trim();

const stripPunctuation = (value: string) => value.replace(/[^a-z0-9 ]/gi, " ");

const buildTitleVariants = (title: string) => {
  const variants = new Set<string>();
  const primary = normalizeTitle(title);
  const alternateBase = [
    primary,
    stripSubtitle(primary),
    reorderArticle(primary),
    reorderArticle(stripSubtitle(primary)),
  ];

  alternateBase.forEach((value) => {
    if (!value) {
      return;
    }
    variants.add(value);
    const cleaned = collapseSpaces(stripPunctuation(value));
    if (cleaned) {
      variants.add(cleaned);
    }
    const andVariant = collapseSpaces(value.replace(/&/g, " and "));
    if (andVariant) {
      variants.add(andVariant);
      const andCleaned = collapseSpaces(stripPunctuation(andVariant));
      if (andCleaned) {
        variants.add(andCleaned);
      }
    }
  });

  const aliasKey = primary.toLowerCase();
  const aliasMap: Record<string, string[]> = {
    se7en: ["Seven"],
  };
  const aliases = aliasMap[aliasKey] ?? [];
  aliases.forEach((alias) => variants.add(alias));

  return Array.from(variants).filter(Boolean);
};

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

const getCacheKey = (title: string) => normalizeTitle(title).toLowerCase();

const fetchTmdbMatch = async (title: string): Promise<TmdbMatch | null> => {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    return null;
  }

  const cacheKey = getCacheKey(title);
  const cached = tmdbCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const { title: cleanTitle, year } = parseTitleYear(title);
  const queries = buildTitleVariants(cleanTitle);

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

      const data = (await response.json()) as {
        results?: Array<{
          id: number;
          poster_path?: string | null;
          overview?: string | null;
          release_date?: string | null;
          vote_average?: number | null;
          vote_count?: number | null;
          backdrop_path?: string | null;
        }>;
      };

      const results = data.results ?? [];
      const bestMatch = year
        ? results.find((item) => item.release_date?.startsWith(String(year)))
        : undefined;
      const fallbackMatch = results.find((item) => item.poster_path) || results[0];
      const match = bestMatch || fallbackMatch;

      if (match) {
        const mapped: TmdbMatch = {
          tmdbId: match.id,
          posterPath: match.poster_path ?? null,
          overview: match.overview ?? null,
          releaseDate: match.release_date ?? null,
          voteAverage: match.vote_average ?? null,
          voteCount: match.vote_count ?? null,
          backdropPath: match.backdrop_path ?? null,
        };
        tmdbCache.set(cacheKey, {
          data: mapped,
          expiresAt: Date.now() + TMDB_CACHE_TTL,
        });
        return mapped;
      }
    }
  } catch {
    tmdbCache.set(cacheKey, { data: null, expiresAt: Date.now() + TMDB_CACHE_TTL });
    return null;
  }

  tmdbCache.set(cacheKey, { data: null, expiresAt: Date.now() + TMDB_CACHE_TTL });
  return null;
};

const fetchPosterPath = async (title: string): Promise<string | null> => {
  const match = await fetchTmdbMatch(title);
  return match?.posterPath ?? null;
};

const fetchTmdbReviews = async (tmdbId: number) => {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    return [] as Array<{
      author: string;
      content: string;
      createdAt?: string | null;
      url?: string | null;
    }>;
  }

  const params = new URLSearchParams({ api_key: apiKey });
  const response = await fetch(`${TMDB_REVIEWS_URL}/${tmdbId}/reviews?${params.toString()}`);
  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as {
    results?: Array<{
      author?: string | null;
      content?: string | null;
      created_at?: string | null;
      url?: string | null;
    }>;
  };

  return (data.results ?? []).map((review) => ({
    author: review.author ?? "Anonymous",
    content: review.content ?? "",
    createdAt: review.created_at ?? null,
    url: review.url ?? null,
  }));
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

moviesRouter.get("/:movieId/details", async (req, res) => {
  const movieId = Number(req.params.movieId);
  if (!Number.isFinite(movieId)) {
    res.status(400).json({ error: "Invalid movie id" });
    return;
  }

  try {
    const row = await fetchMovieById(movieId);
    if (!row) {
      res.status(404).json({ error: "Movie not found" });
      return;
    }

    const tmdb = await fetchTmdbMatch(row.title);
    res.json({
      movie: mapSummary(row, tmdb?.posterPath ?? null),
      tmdb: tmdb
        ? {
            overview: tmdb.overview ?? null,
            releaseDate: tmdb.releaseDate ?? null,
            voteAverage: tmdb.voteAverage ?? null,
            voteCount: tmdb.voteCount ?? null,
            backdropUrl: buildPosterUrl(tmdb.backdropPath ?? null),
          }
        : null,
      movieLens: {
        ratingAvg: row.rating_avg != null ? Number(row.rating_avg) : null,
        ratingCount: row.rating_count != null ? Number(row.rating_count) : null,
      },
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

moviesRouter.get("/:movieId/reviews", async (req, res) => {
  const movieId = Number(req.params.movieId);
  if (!Number.isFinite(movieId)) {
    res.status(400).json({ error: "Invalid movie id" });
    return;
  }

  try {
    const row = await fetchMovieById(movieId);
    if (!row) {
      res.status(404).json({ error: "Movie not found" });
      return;
    }

    const tmdb = await fetchTmdbMatch(row.title);
    if (!tmdb) {
      res.json({ reviews: [] });
      return;
    }

    const reviews = await fetchTmdbReviews(tmdb.tmdbId);
    res.json({ reviews });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
