from __future__ import annotations

import os
import pickle
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional


@dataclass
class MFWeights:
    p: List[List[float]]
    q: List[List[float]]
    bu: List[float]
    bi: List[float]
    mu: float
    user_id_map: Dict[int, int]
    movie_id_map: Dict[int, int]


_CACHE: Optional[MFWeights] = None


def _load_weights() -> Optional[MFWeights]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE

    model_path = os.environ.get("MODEL_PATH", "/app/models/mf_model_weights.pkl")
    if not os.path.exists(model_path):
        return None

    with open(model_path, "rb") as handle:
        data = pickle.load(handle)

    _CACHE = MFWeights(
        p=data.get("P"),
        q=data.get("Q"),
        bu=data.get("bu"),
        bi=data.get("bi"),
        mu=float(data.get("mu", 0.0)),
        user_id_map=data.get("user_id_map", {}),
        movie_id_map=data.get("movie_id_map", {}),
    )
    return _CACHE


def _dot(vec_a: List[float], vec_b: List[float]) -> float:
    return sum(a * b for a, b in zip(vec_a, vec_b))


def score_movies(user_id: Optional[str], movie_ids: Iterable[int]) -> Dict[int, float]:
    weights = _load_weights()
    if not weights:
        return {mid: 0.0 for mid in movie_ids}

    mapped_user = None
    if user_id is not None:
        try:
            mapped_user = weights.user_id_map.get(int(user_id))
        except ValueError:
            mapped_user = None

    scores: Dict[int, float] = {}

    for movie_id in movie_ids:
        mapped_movie = weights.movie_id_map.get(movie_id)
        if mapped_movie is None:
            continue

        base = weights.mu + (weights.bi[mapped_movie] if weights.bi is not None else 0.0)

        if mapped_user is None:
            scores[movie_id] = base
            continue

        user_bias = weights.bu[mapped_user] if weights.bu is not None else 0.0
        factor_score = _dot(weights.p[mapped_user], weights.q[mapped_movie])
        scores[movie_id] = base + user_bias + factor_score

    return scores
