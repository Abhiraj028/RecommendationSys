from __future__ import annotations

import os
import pickle
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


@dataclass
class MFWeights:
    p: List[List[float]]
    q: List[List[float]]
    bu: List[float]
    bi: List[float]
    mu: float
    user_id_map: Dict[int, int]
    movie_id_map: Dict[int, int]


@dataclass
class MatrixMovieScore:
    score: float
    basis: str
    latent_factors: List[Tuple[int, float]]


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


def _to_list(values: Sequence[float]) -> List[float]:
    return [float(value) for value in values]


def _top_latent_factors(terms: Sequence[float], top_k: int = 5) -> List[Tuple[int, float]]:
    pairs = [(index, float(value)) for index, value in enumerate(terms)]
    pairs.sort(key=lambda item: abs(item[1]), reverse=True)
    return pairs[:top_k]


def _mapped_movie_indices(weights: MFWeights, movie_ids: Iterable[int]) -> List[int]:
    indices: List[int] = []
    for movie_id in movie_ids:
        mapped = weights.movie_id_map.get(int(movie_id))
        if mapped is None:
            continue
        indices.append(mapped)
    return indices


def _mean_vector(vectors: List[List[float]]) -> List[float]:
    if not vectors:
        return []
    dims = len(vectors[0])
    accum = [0.0] * dims
    for vec in vectors:
        for index, value in enumerate(vec):
            accum[index] += float(value)
    return [value / len(vectors) for value in accum]


def _profile_user_vector(
    weights: MFWeights,
    liked_movie_ids: Iterable[int],
    disliked_movie_ids: Iterable[int],
) -> Optional[List[float]]:
    liked_indices = _mapped_movie_indices(weights, liked_movie_ids)
    disliked_indices = _mapped_movie_indices(weights, disliked_movie_ids)

    if not liked_indices:
        return None

    liked_vectors = [_to_list(weights.q[index]) for index in liked_indices]
    user_vec = _mean_vector(liked_vectors)

    if disliked_indices:
        disliked_vectors = [_to_list(weights.q[index]) for index in disliked_indices]
        disliked_mean = _mean_vector(disliked_vectors)
        user_vec = [u - 0.5 * d for u, d in zip(user_vec, disliked_mean)]

    return user_vec


def score_movies(
    user_id: Optional[str],
    movie_ids: Iterable[int],
    liked_movie_ids: Iterable[int] = (),
    disliked_movie_ids: Iterable[int] = (),
) -> Dict[int, MatrixMovieScore]:
    weights = _load_weights()
    if not weights:
        return {
            int(mid): MatrixMovieScore(
                score=0.0,
                basis="matrix factors unavailable (weights missing)",
                latent_factors=[],
            )
            for mid in movie_ids
        }

    mapped_user = None
    if user_id is not None:
        try:
            mapped_user = weights.user_id_map.get(int(user_id))
        except ValueError:
            mapped_user = None

    user_vector: Optional[List[float]] = None
    user_bias = 0.0
    if mapped_user is not None:
        user_vector = _to_list(weights.p[mapped_user])
        user_bias = float(weights.bu[mapped_user]) if weights.bu is not None else 0.0
        basis = "matrix factors (explicit user embedding)"
    else:
        user_vector = _profile_user_vector(weights, liked_movie_ids, disliked_movie_ids)
        basis = (
            "matrix factors (profile inferred from likes/dislikes)"
            if user_vector is not None
            else "matrix bias terms only (no user profile)"
        )

    scores: Dict[int, MatrixMovieScore] = {}

    for movie_id in movie_ids:
        int_movie_id = int(movie_id)
        mapped_movie = weights.movie_id_map.get(int_movie_id)
        if mapped_movie is None:
            continue

        base = weights.mu + (weights.bi[mapped_movie] if weights.bi is not None else 0.0)

        if user_vector is None:
            scores[int_movie_id] = MatrixMovieScore(
                score=float(base),
                basis=basis,
                latent_factors=[],
            )
            continue

        movie_vector = _to_list(weights.q[mapped_movie])
        latent_terms = [u * v for u, v in zip(user_vector, movie_vector)]
        factor_score = _dot(user_vector, movie_vector)

        scores[int_movie_id] = MatrixMovieScore(
            score=float(base + user_bias + factor_score),
            basis=basis,
            latent_factors=_top_latent_factors(latent_terms),
        )

    return scores
