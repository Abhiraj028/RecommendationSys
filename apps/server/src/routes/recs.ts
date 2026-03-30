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
    const likedMovieIds = payload.likedMovieIds ?? [];
    const dislikedMovieIds = payload.dislikedMovieIds ?? [];
    const excludeIds = new Set([...likedMovieIds, ...dislikedMovieIds]);

    let candidateIds = payload.candidateMovieIds ?? [];
    if (!candidateIds.length) {
      candidateIds = await fetchPopularMovieIds(200);
    }
    candidateIds = candidateIds.filter((id) => !excludeIds.has(id));

    const rows = await Promise.all(
      payload.models.map(async (model) => {
        const response = await postJson<RecommendationResponse>("/recommendations", {
          ...payload,
          model,
          likedMovieIds,
          dislikedMovieIds,
          candidateMovieIds: candidateIds,
        });
        return {
          model,
          items: response.items.filter((item) => !excludeIds.has(item.movieId)),
        };
      })
    );

    const result: RecommendationRowsResponse = { rows };
    res.json(result);
  } catch (error) {
    res.status(502).json({
      error: (error as Error).message,
    });
  }
});
