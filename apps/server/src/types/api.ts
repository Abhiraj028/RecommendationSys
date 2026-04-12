export type RecommendationModel =
  | "baseline"
  | "user-user"
  | "item-item"
  | "matrix-cf"
  | "neural-cf";

export type PairwiseRequest = {
  userId?: string;
  candidateMovieIds: number[];
  excludeMovieIds?: number[];
  pairCount?: number;
};

export type PairwiseResponse = {
  pairs: Array<{ leftMovieId: number; rightMovieId: number }>;
};

export type RecommendationRequest = {
  model: RecommendationModel;
  userId?: string;
  likedMovieIds?: number[];
  dislikedMovieIds?: number[];
  seenMovieIds?: number[];
  candidateMovieIds?: number[];
  limit?: number;
};

export type RecommendationRowsRequest = Omit<RecommendationRequest, "model"> & {
  models: RecommendationModel[];
  candidateMovieIds?: number[];
  limit?: number;
};

export type RecommendationRowsResponse = {
  rows: Array<{
    model: RecommendationModel;
    items: RecommendationItem[];
  }>;
};

export type RecommendationFactor = {
  index: number;
  contribution: number;
};

export type RecommendationExplain = {
  basis?: string;
  latentFactors?: RecommendationFactor[];
};

export type RecommendationItem = {
  movieId: number;
  score: number;
  reason: string;
  explain?: RecommendationExplain;
};

export type RecommendationResponse = {
  model: RecommendationModel;
  items: RecommendationItem[];
  generatedAt: string;
};

export type FeedbackRequest = {
  userId?: string;
  movieId: number;
  action: "like" | "dislike" | "watch" | "rate";
  rating?: number;
  model?: RecommendationModel;
};

export type FeedbackResponse = {
  ok: boolean;
};

export type MovieSummary = {
  movieId: number;
  title: string;
  genres: string[];
  posterUrl?: string | null;
  thumbnailUrl?: string | null;
};
