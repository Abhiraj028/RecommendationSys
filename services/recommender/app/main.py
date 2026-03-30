from fastapi import FastAPI

from .engines import make_pairs, recommend
from .schemas import (
    FeedbackRequest,
    FeedbackResponse,
    PairwiseRequest,
    PairwiseResponse,
    RecommendationRequest,
    RecommendationResponse,
)

app = FastAPI(title="Recommender Service")


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/cold-start/pairs", response_model=PairwiseResponse)
async def cold_start_pairs(payload: PairwiseRequest):
    return PairwiseResponse(pairs=make_pairs(payload))


@app.post("/recommendations", response_model=RecommendationResponse)
async def recommendations(payload: RecommendationRequest):
    return recommend(payload)


@app.post("/feedback", response_model=FeedbackResponse)
async def feedback(_payload: FeedbackRequest):
    return FeedbackResponse(ok=True)
