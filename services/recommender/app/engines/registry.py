from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, List

from ..schemas import Pair, PairwiseRequest, RecommendationItem, RecommendationRequest, RecommendationResponse
from .db_rankers import rank_baseline, rank_item_item, rank_user_user
from .matrix_cf import score_movies as score_matrix_cf
from .neural_cf import score_movies as score_neural_cf


def _dedupe(ids: Iterable[int]) -> List[int]:
    seen = set()
    ordered: List[int] = []
    for value in ids:
        movie_id = int(value)
        if movie_id <= 0 or movie_id in seen:
            continue
        seen.add(movie_id)
        ordered.append(movie_id)
    return ordered


def _candidate_pool(payload: RecommendationRequest) -> List[int]:
    if payload.candidate_movie_ids:
        pool = _dedupe(payload.candidate_movie_ids)
    else:
        pool = _dedupe([*payload.liked_movie_ids, *payload.disliked_movie_ids, *payload.seen_movie_ids])

    excluded = set(payload.seen_movie_ids).union(payload.disliked_movie_ids)
    return [movie_id for movie_id in pool if movie_id not in excluded]


def recommend(payload: RecommendationRequest) -> RecommendationResponse:
    candidates = _candidate_pool(payload)
    limit = max(1, int(payload.limit))
    items: List[RecommendationItem] = []

    if payload.model == "baseline":
        ranked = rank_baseline(candidates, payload.liked_movie_ids, payload.disliked_movie_ids, limit)
        items = [
            RecommendationItem(movie_id=movie_id, score=float(score), reason=reason)
            for movie_id, score, reason in ranked
        ]
    elif payload.model == "user-user":
        ranked = rank_user_user(candidates, payload.liked_movie_ids, payload.disliked_movie_ids, limit)
        items = [
            RecommendationItem(movie_id=movie_id, score=float(score), reason=reason)
            for movie_id, score, reason in ranked
        ]
    elif payload.model == "item-item":
        ranked = rank_item_item(candidates, payload.liked_movie_ids, payload.disliked_movie_ids, limit)
        items = [
            RecommendationItem(movie_id=movie_id, score=float(score), reason=reason)
            for movie_id, score, reason in ranked
        ]
    elif payload.model == "matrix-cf":
        scores = score_matrix_cf(
            payload.user_id,
            candidates,
            payload.liked_movie_ids,
            payload.disliked_movie_ids,
        )
        items = [
            RecommendationItem(
                movie_id=mid,
                score=detail.score,
                reason=detail.basis,
                explain={
                    "basis": detail.basis,
                    "latent_factors": [
                        {"index": index, "contribution": contribution}
                        for index, contribution in detail.latent_factors
                    ],
                },
            )
            for mid, detail in scores.items()
        ]
        items.sort(key=lambda item: item.score, reverse=True)
        items = items[:limit]
    elif payload.model == "neural-cf":
        neural_scores, reason, latent_by_movie = score_neural_cf(
            payload.user_id,
            candidates,
            payload.liked_movie_ids,
            payload.disliked_movie_ids,
        )
        if neural_scores:
            items = [
                RecommendationItem(
                    movie_id=mid,
                    score=score,
                    reason=reason,
                    explain={
                        "basis": reason,
                        "latent_factors": [
                            {"index": index, "contribution": contribution}
                            for index, contribution in latent_by_movie.get(mid, [])
                        ],
                    },
                )
                for mid, score in neural_scores.items()
            ]
            items.sort(key=lambda item: item.score, reverse=True)
            items = items[:limit]
        else:
            ranked = rank_baseline(candidates, payload.liked_movie_ids, payload.disliked_movie_ids, limit)
            items = [
                RecommendationItem(movie_id=movie_id, score=float(score), reason=f"{reason}; baseline fallback")
                for movie_id, score, _ in ranked
            ]
    else:
        ranked = rank_baseline(candidates, payload.liked_movie_ids, payload.disliked_movie_ids, limit)
        items = [
            RecommendationItem(movie_id=movie_id, score=float(score), reason="unknown model fallback to baseline")
            for movie_id, score, _ in ranked
        ]

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
