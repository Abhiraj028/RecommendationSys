import { Router } from "express";

import { postJson } from "../services/recsClient.js";
import { fetchPopularMovieIds } from "../db/movies.js";
import type {
  RecommendationRequest,
  RecommendationResponse,
  RecommendationRowsRequest,
  RecommendationRowsResponse,
} from "../types/api.js";

export const recsRouter = Router();

const uniqueItemsByMovie = (items: RecommendationResponse["items"]) => {
  const seen = new Set<number>();
  return items.filter((item) => {
    if (seen.has(item.movieId)) {
      return false;
    }
    seen.add(item.movieId);
    return true;
  });
};

const diversifyAcrossRows = (
  rows: RecommendationRowsResponse["rows"],
  limit: number
): RecommendationRowsResponse["rows"] => {
  const usedMovieIds = new Set<number>();

  return rows.map((row) => {
    const primary = [] as typeof row.items;
    const fallback = [] as typeof row.items;

    for (const item of row.items) {
      if (!usedMovieIds.has(item.movieId) && primary.length < limit) {
        primary.push(item);
      } else {
        fallback.push(item);
      }
    }

    for (const item of fallback) {
      if (primary.length >= limit) {
        break;
      }
      primary.push(item);
    }

    primary.forEach((item) => usedMovieIds.add(item.movieId));
    return {
      ...row,
      items: primary.slice(0, limit),
    };
  });
};

recsRouter.post("/", async (req, res) => {
  const payload = req.body as RecommendationRequest;

  try {
    const response = await postJson<RecommendationResponse>("/recommendations", payload);
    res.json(response);
  } catch (error) {
    res.status(502).json({
      error: (error as Error).message,
    });
  }
});

recsRouter.post("/rows", async (req, res) => {
  const payload = req.body as RecommendationRowsRequest;

  try {
    const rowLimit = Math.max(1, payload.limit ?? 12);
    const perModelLimit = Math.max(rowLimit * 4, 32);
    const likedMovieIds = payload.likedMovieIds ?? [];
    const dislikedMovieIds = payload.dislikedMovieIds ?? [];
    const excludeIds = new Set([...likedMovieIds, ...dislikedMovieIds]);

    let candidateIds = payload.candidateMovieIds ?? [];
    if (!candidateIds.length) {
      candidateIds = await fetchPopularMovieIds(1200);
    }
    candidateIds = candidateIds.filter((id) => !excludeIds.has(id));

    const rows = await Promise.all(
      payload.models.map(async (model) => {
        const response = await postJson<RecommendationResponse>("/recommendations", {
          ...payload,
          model,
          limit: perModelLimit,
          likedMovieIds,
          dislikedMovieIds,
          candidateMovieIds: candidateIds,
        });
        return {
          model,
          items: uniqueItemsByMovie(
            response.items.filter((item) => !excludeIds.has(item.movieId))
          ),
        };
      })
    );

    const result: RecommendationRowsResponse = {
      rows: diversifyAcrossRows(rows, rowLimit),
    };
    res.json(result);
  } catch (error) {
    res.status(502).json({
      error: (error as Error).message,
    });
  }
});
