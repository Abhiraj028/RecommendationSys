import express from "express";
import cors from "cors";

import { healthRouter } from "./routes/health.js";
import { recsRouter } from "./routes/recs.js";
import { coldStartRouter } from "./routes/coldStart.js";
import { feedbackRouter } from "./routes/feedback.js";
import { moviesRouter } from "./routes/movies.js";
import { analyticsRouter } from "./routes/analytics.js";

export const createApp = () => {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.use("/health", healthRouter);
  app.use("/api/recommendations", recsRouter);
  app.use("/api/cold-start", coldStartRouter);
  app.use("/api/feedback", feedbackRouter);
  app.use("/api/movies", moviesRouter);
  app.use("/api/analytics", analyticsRouter);

  return app;
};
