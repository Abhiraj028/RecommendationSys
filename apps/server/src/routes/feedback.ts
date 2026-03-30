import { Router } from "express";

import { postJson } from "../services/recsClient.js";
import type { FeedbackRequest, FeedbackResponse } from "../types/api.js";

export const feedbackRouter = Router();

feedbackRouter.post("/", async (req, res) => {
  const payload = req.body as FeedbackRequest;

  try {
    const response = await postJson<FeedbackResponse>("/feedback", payload);
    res.json(response);
  } catch (error) {
    res.status(502).json({
      error: (error as Error).message,
    });
  }
});
