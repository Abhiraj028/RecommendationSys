from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Iterable, List

from ..schemas import Pair, PairwiseRequest, RecommendationItem, RecommendationRequest, RecommendationResponse
from .matrix_cf import score_movies


def _stable_score(model: str, movie_id: int) -> float:
    digest = hashlib.sha1(f"{model}:{movie_id}".encode("utf-8")).hexdigest()
    return int(digest[:6], 16) / 0xFFFFFF


def _rank(
    model: str,
    movie_ids: Iterable[int],
    seen_ids: Iterable[int],
    liked_ids: Iterable[int],
    disliked_ids: Iterable[int],
    limit: int,
) -> List[RecommendationItem]:
    seen = set(seen_ids)
    liked = set(liked_ids)
    disliked = set(disliked_ids)
    candidates = [mid for mid in movie_ids if mid not in seen and mid not in disliked]

    boost = 0.15 if model in {"user-user", "item-item"} else 0.1
    scored = []
    for mid in candidates:
        score = _stable_score(model, mid)
        if mid in liked:
            score += boost
        scored.append(
            RecommendationItem(
                movie_id=mid,
                score=score,
                reason=f"ranked by {model}",
            )
        )

    scored.sort(key=lambda item: item.score, reverse=True)
    return scored[:limit]


def recommend(payload: RecommendationRequest) -> RecommendationResponse:
    if payload.candidate_movie_ids:
        pool = payload.candidate_movie_ids
    else:
        pool = payload.liked_movie_ids + payload.disliked_movie_ids + payload.seen_movie_ids

    if payload.model == "matrix-cf":
        scores = score_movies(payload.user_id, pool)
        items = [
            RecommendationItem(
                movie_id=mid,
                score=score,
                reason="matrix factorization",
            )
            for mid, score in scores.items()
        ]
        items.sort(key=lambda item: item.score, reverse=True)
        items = items[: payload.limit]
    else:
        items = _rank(
            payload.model,
            pool,
            payload.seen_movie_ids,
            payload.liked_movie_ids,
            payload.disliked_movie_ids,
            payload.limit,
        )
    return RecommendationResponse(
        model=payload.model,
        items=items,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )


def make_pairs(payload: PairwiseRequest) -> List[Pair]:
    pool = [mid for mid in payload.candidate_movie_ids if mid not in set(payload.exclude_movie_ids)]
    pairs: List[Pair] = []

    for i in range(0, min(len(pool), payload.pair_count * 2), 2):
        if i + 1 >= len(pool):
            break
        pairs.append(Pair(left_movie_id=pool[i], right_movie_id=pool[i + 1]))

    return pairs
