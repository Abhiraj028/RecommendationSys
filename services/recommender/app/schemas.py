from typing import List, Optional
from pydantic import BaseModel, Field, ConfigDict


def _to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part.title() for part in parts[1:])


class PairwiseRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)
    user_id: Optional[str] = None
    candidate_movie_ids: List[int]
    exclude_movie_ids: List[int] = Field(default_factory=list)
    pair_count: int = 5


class Pair(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)
    left_movie_id: int
    right_movie_id: int


class PairwiseResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)
    pairs: List[Pair]


class RecommendationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)
    model: str
    user_id: Optional[str] = None
    liked_movie_ids: List[int] = Field(default_factory=list)
    disliked_movie_ids: List[int] = Field(default_factory=list)
    seen_movie_ids: List[int] = Field(default_factory=list)
    candidate_movie_ids: List[int] = Field(default_factory=list)
    limit: int = 10


class RecommendationItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)
    movie_id: int
    score: float
    reason: str
    explain: Optional["RecommendationExplain"] = None


class FactorContribution(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)
    index: int
    contribution: float


class RecommendationExplain(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)
    basis: Optional[str] = None
    latent_factors: List[FactorContribution] = Field(default_factory=list)


class RecommendationResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)
    model: str
    items: List[RecommendationItem]
    generated_at: str


class FeedbackRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)
    user_id: Optional[str] = None
    movie_id: int
    action: str
    rating: Optional[float] = None
    model: Optional[str] = None


class FeedbackResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=_to_camel)
    ok: bool
