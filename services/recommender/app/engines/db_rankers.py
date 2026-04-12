from __future__ import annotations

import math
import os
from collections import Counter, defaultdict
from typing import Dict, Iterable, List, Tuple

import psycopg2


def _dedupe(ids: Iterable[int]) -> List[int]:
    seen = set()
    ordered: List[int] = []
    for value in ids:
        mid = int(value)
        if mid <= 0 or mid in seen:
            continue
        seen.add(mid)
        ordered.append(mid)
    return ordered


def _connect():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return None
    return psycopg2.connect(database_url)


def _cosine_dense(left: List[float], right: List[float]) -> float:
    if not left or not right:
        return 0.0
    numerator = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return numerator / (left_norm * right_norm)


def _cosine_sparse(left: Dict[int, float], right: Dict[int, float]) -> float:
    if not left or not right:
        return 0.0
    common = set(left.keys()).intersection(right.keys())
    if not common:
        return 0.0

    numerator = sum(left[key] * right[key] for key in common)
    left_norm = math.sqrt(sum(value * value for value in left.values()))
    right_norm = math.sqrt(sum(value * value for value in right.values()))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return numerator / (left_norm * right_norm)


def _fallback_score_map(candidate_ids: List[int]) -> Dict[int, float]:
    # Deterministic fallback so API is stable even without DB connectivity.
    return {mid: 3.0 + (mid % 100) / 200.0 for mid in candidate_ids}


def _baseline_score_map(
    candidate_ids: List[int],
    liked_movie_ids: List[int],
    disliked_movie_ids: List[int],
) -> Dict[int, float]:
    candidate_ids = _dedupe(candidate_ids)
    if not candidate_ids:
        return {}

    conn = _connect()
    if conn is None:
        return _fallback_score_map(candidate_ids)

    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    COALESCE(AVG(rating_avg), 3.5)::float8,
                    COALESCE(AVG(rating_count), 20)::float8
                FROM movie_stats
                """
            )
            global_avg, global_count = cursor.fetchone()

            cursor.execute(
                """
                SELECT movie_id, rating_avg::float8, rating_count
                FROM movie_stats
                WHERE movie_id = ANY(%s)
                """,
                (candidate_ids,),
            )
            stats_rows = cursor.fetchall()

            movie_ids_for_genres = _dedupe([*candidate_ids, *liked_movie_ids, *disliked_movie_ids])
            cursor.execute(
                """
                SELECT movie_id, genres
                FROM movies
                WHERE movie_id = ANY(%s)
                """,
                (movie_ids_for_genres,),
            )
            genre_rows = cursor.fetchall()
    finally:
        conn.close()

    stats_by_movie: Dict[int, Tuple[float, int]] = {
        int(movie_id): (float(rating_avg), int(rating_count))
        for movie_id, rating_avg, rating_count in stats_rows
    }

    genres_by_movie: Dict[int, List[str]] = {
        int(movie_id): [str(value) for value in (genres or [])]
        for movie_id, genres in genre_rows
    }

    liked_genres = Counter(
        genre
        for movie_id in liked_movie_ids
        for genre in genres_by_movie.get(movie_id, [])
    )
    disliked_genres = Counter(
        genre
        for movie_id in disliked_movie_ids
        for genre in genres_by_movie.get(movie_id, [])
    )

    prior_weight = max(10.0, min(80.0, float(global_count)))
    preference_mass = max(1, len(liked_movie_ids) + len(disliked_movie_ids))

    scores: Dict[int, float] = {}
    for movie_id in candidate_ids:
        avg, cnt = stats_by_movie.get(movie_id, (float(global_avg), 0))
        bayes = ((cnt * avg) + (prior_weight * float(global_avg))) / (cnt + prior_weight)

        genres = genres_by_movie.get(movie_id, [])
        if genres:
            genre_signal = 0.0
            for genre in genres:
                genre_signal += liked_genres.get(genre, 0)
                genre_signal -= 1.2 * disliked_genres.get(genre, 0)
            genre_signal /= max(1.0, float(len(genres) * preference_mass))
        else:
            genre_signal = 0.0

        popularity_boost = min(0.35, math.log1p(max(0, cnt)) / 20.0)
        scores[movie_id] = bayes + (0.35 * genre_signal) + popularity_boost

    return scores


def rank_baseline(
    candidate_ids: Iterable[int],
    liked_movie_ids: Iterable[int],
    disliked_movie_ids: Iterable[int],
    limit: int,
) -> List[Tuple[int, float, str]]:
    candidates = _dedupe(candidate_ids)
    if not candidates:
        return []

    scores = _baseline_score_map(candidates, _dedupe(liked_movie_ids), _dedupe(disliked_movie_ids))
    ranked = sorted(scores.items(), key=lambda entry: entry[1], reverse=True)
    return [
        (movie_id, float(score), "bayesian popularity + genre affinity")
        for movie_id, score in ranked[:limit]
    ]


def rank_user_user(
    candidate_ids: Iterable[int],
    liked_movie_ids: Iterable[int],
    disliked_movie_ids: Iterable[int],
    limit: int,
) -> List[Tuple[int, float, str]]:
    candidates = _dedupe(candidate_ids)
    liked = _dedupe(liked_movie_ids)
    disliked = _dedupe(disliked_movie_ids)
    if not candidates:
        return []

    anchors = _dedupe([*liked, *disliked])
    baseline_scores = _baseline_score_map(candidates, liked, disliked)
    if not anchors:
        ranked = sorted(baseline_scores.items(), key=lambda entry: entry[1], reverse=True)
        return [(movie_id, score, "baseline fallback (no profile)") for movie_id, score in ranked[:limit]]

    conn = _connect()
    if conn is None:
        ranked = sorted(baseline_scores.items(), key=lambda entry: entry[1], reverse=True)
        return [(movie_id, score, "baseline fallback (db unavailable)") for movie_id, score in ranked[:limit]]

    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT DISTINCT user_id FROM ratings WHERE movie_id = ANY(%s) LIMIT 5000",
                (anchors,),
            )
            neighbor_rows = cursor.fetchall()

            if not neighbor_rows:
                ranked = sorted(baseline_scores.items(), key=lambda entry: entry[1], reverse=True)
                return [
                    (movie_id, score, "baseline fallback (no neighbors)")
                    for movie_id, score in ranked[:limit]
                ]

            neighbor_ids = [int(row[0]) for row in neighbor_rows]
            relevant_movies = _dedupe([*anchors, *candidates])
            cursor.execute(
                """
                SELECT user_id, movie_id, rating::float8
                FROM ratings
                WHERE user_id = ANY(%s) AND movie_id = ANY(%s)
                """,
                (neighbor_ids, relevant_movies),
            )
            ratings_rows = cursor.fetchall()
    finally:
        conn.close()

    pref = {movie_id: 5.0 for movie_id in liked}
    pref.update({movie_id: 1.0 for movie_id in disliked if movie_id not in pref})

    user_anchor: Dict[int, Dict[int, float]] = defaultdict(dict)
    user_candidate: Dict[int, Dict[int, float]] = defaultdict(dict)
    candidate_set = set(candidates)
    anchor_set = set(anchors)

    for user_id, movie_id, rating in ratings_rows:
        uid = int(user_id)
        mid = int(movie_id)
        value = float(rating)
        if mid in anchor_set:
            user_anchor[uid][mid] = value
        if mid in candidate_set:
            user_candidate[uid][mid] = value

    numerators = defaultdict(float)
    denominators = defaultdict(float)
    supporters = defaultdict(int)

    for user_id, anchor_ratings in user_anchor.items():
        common = [movie_id for movie_id in anchors if movie_id in anchor_ratings and movie_id in pref]
        if not common:
            continue

        left = [pref[movie_id] for movie_id in common]
        right = [anchor_ratings[movie_id] for movie_id in common]
        similarity = _cosine_dense(left, right)
        if similarity <= 0:
            continue

        # Down-weight weak overlaps so one common movie cannot dominate.
        similarity *= len(common) / (len(common) + 2.0)

        for movie_id, rating in user_candidate.get(user_id, {}).items():
            numerators[movie_id] += similarity * rating
            denominators[movie_id] += abs(similarity)
            supporters[movie_id] += 1

    ranked: List[Tuple[int, float, str]] = []
    for movie_id in candidates:
        base = baseline_scores.get(movie_id, 3.5)
        if denominators[movie_id] > 0:
            collaborative = numerators[movie_id] / denominators[movie_id]
            score = (0.7 * collaborative) + (0.3 * base)
            reason = f"user-user cf ({supporters[movie_id]} neighbors)"
        else:
            score = base
            reason = "baseline fallback (no overlap)"
        ranked.append((movie_id, float(score), reason))

    ranked.sort(key=lambda entry: entry[1], reverse=True)
    return ranked[:limit]


def rank_item_item(
    candidate_ids: Iterable[int],
    liked_movie_ids: Iterable[int],
    disliked_movie_ids: Iterable[int],
    limit: int,
) -> List[Tuple[int, float, str]]:
    candidates = _dedupe(candidate_ids)
    liked = _dedupe(liked_movie_ids)
    disliked = _dedupe(disliked_movie_ids)
    if not candidates:
        return []

    anchors = _dedupe([*liked, *disliked])
    baseline_scores = _baseline_score_map(candidates, liked, disliked)
    if not anchors:
        ranked = sorted(baseline_scores.items(), key=lambda entry: entry[1], reverse=True)
        return [(movie_id, score, "baseline fallback (no profile)") for movie_id, score in ranked[:limit]]

    conn = _connect()
    if conn is None:
        ranked = sorted(baseline_scores.items(), key=lambda entry: entry[1], reverse=True)
        return [(movie_id, score, "baseline fallback (db unavailable)") for movie_id, score in ranked[:limit]]

    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT DISTINCT user_id FROM ratings WHERE movie_id = ANY(%s) LIMIT 8000",
                (anchors,),
            )
            neighbor_rows = cursor.fetchall()
            if not neighbor_rows:
                ranked = sorted(baseline_scores.items(), key=lambda entry: entry[1], reverse=True)
                return [
                    (movie_id, score, "baseline fallback (no anchor users)")
                    for movie_id, score in ranked[:limit]
                ]

            neighbor_ids = [int(row[0]) for row in neighbor_rows]
            relevant_movies = _dedupe([*anchors, *candidates])
            cursor.execute(
                """
                SELECT user_id, movie_id, rating::float8
                FROM ratings
                WHERE user_id = ANY(%s) AND movie_id = ANY(%s)
                """,
                (neighbor_ids, relevant_movies),
            )
            ratings_rows = cursor.fetchall()
    finally:
        conn.close()

    item_user_ratings: Dict[int, Dict[int, float]] = defaultdict(dict)
    for user_id, movie_id, rating in ratings_rows:
        item_user_ratings[int(movie_id)][int(user_id)] = float(rating)

    anchor_pref: Dict[int, float] = {movie_id: 1.0 for movie_id in liked}
    for movie_id in disliked:
        if movie_id not in anchor_pref:
            anchor_pref[movie_id] = -1.2

    ranked: List[Tuple[int, float, str]] = []
    for movie_id in candidates:
        base = baseline_scores.get(movie_id, 3.5)
        current = item_user_ratings.get(movie_id, {})
        if not current:
            ranked.append((movie_id, float(base), "baseline fallback (sparse item vectors)"))
            continue

        weighted = 0.0
        weight_sum = 0.0
        pair_count = 0

        for anchor_id, preference in anchor_pref.items():
            if anchor_id == movie_id:
                continue
            anchor_vector = item_user_ratings.get(anchor_id, {})
            if not anchor_vector:
                continue

            common = set(current.keys()).intersection(anchor_vector.keys())
            if len(common) < 3:
                continue

            similarity = _cosine_sparse(current, anchor_vector)
            if similarity == 0:
                continue

            weighted += similarity * preference
            weight_sum += abs(similarity)
            pair_count += 1

        if weight_sum > 0:
            signal = weighted / weight_sum
            score = base + (0.9 * signal)
            reason = f"item-item cf ({pair_count} similar anchors)"
        else:
            score = base
            reason = "baseline fallback (no similar anchors)"

        ranked.append((movie_id, float(score), reason))

    ranked.sort(key=lambda entry: entry[1], reverse=True)
    return ranked[:limit]
