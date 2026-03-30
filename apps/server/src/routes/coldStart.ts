import { Router } from "express";

import { postJson } from "../services/recsClient.js";
import type { PairwiseRequest, PairwiseResponse } from "../types/api.js";

export const coldStartRouter = Router();

coldStartRouter.post("/pairs", async (req, res) => {
  const payload = req.body as PairwiseRequest;

  try {
    const response = await postJson<PairwiseResponse>("/cold-start/pairs", payload);
    res.json(response);
  } catch (error) {
    res.status(502).json({
      error: (error as Error).message,
    });
  }
});
