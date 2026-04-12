from __future__ import annotations

import io
import math
import os
import pickle
import re
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np


@dataclass
class NeuMFWeights:
    user_emb_mf: np.ndarray
    item_emb_mf: np.ndarray
    user_emb_mlp: np.ndarray
    item_emb_mlp: np.ndarray
    mlp_layers: List[Tuple[np.ndarray, np.ndarray]]
    out_w: np.ndarray
    out_b: np.ndarray
    user_id_map: Dict[int, int]
    movie_id_map: Dict[int, int]


_CACHE: Optional[NeuMFWeights] = None


def _candidate_paths() -> List[str]:
    env_path = os.environ.get("NEUMF_MODEL_PATH")
    paths = [
        env_path,
        "/app/models/neumf_model_weights.pkl",
        "/app/neumf_model_weights.pkl",
    ]
    return [path for path in paths if path]


def _to_numpy(value) -> np.ndarray:
    if hasattr(value, "detach") and hasattr(value, "cpu"):
        return value.detach().cpu().numpy().astype(np.float32)
    return np.asarray(value, dtype=np.float32)


def _load_id_maps_from_mf() -> Tuple[Dict[int, int], Dict[int, int]]:
    model_path = os.environ.get("MODEL_PATH", "/app/models/mf_model_weights.pkl")
    if not os.path.exists(model_path):
        return {}, {}

    try:
        with open(model_path, "rb") as handle:
            data = pickle.load(handle)
        user_map = data.get("user_id_map", {}) if isinstance(data, dict) else {}
        movie_map = data.get("movie_id_map", {}) if isinstance(data, dict) else {}
        if not isinstance(user_map, dict) or not isinstance(movie_map, dict):
            return {}, {}
        return ({int(k): int(v) for k, v in user_map.items()}, {int(k): int(v) for k, v in movie_map.items()})
    except Exception:
        return {}, {}


def _load_state_dict(path: str):
    import torch

    try:
        raw = torch.load(path, map_location=torch.device("cpu"))
    except RuntimeError as exc:
        # Handle legacy CUDA-pickled tensors on CPU-only hosts.
        if "deserialize object on a CUDA device" not in str(exc):
            raise

        original_loader = torch.storage._load_from_bytes

        def _cpu_loader(blob: bytes):
            return torch.load(io.BytesIO(blob), map_location=torch.device("cpu"))

        torch.storage._load_from_bytes = _cpu_loader
        try:
            with open(path, "rb") as handle:
                raw = pickle.load(handle)
        finally:
            torch.storage._load_from_bytes = original_loader

    if isinstance(raw, dict) and "state_dict" in raw and isinstance(raw["state_dict"], dict):
        return raw["state_dict"]
    return raw


def _find_key(state_dict: Dict[str, object], key: str):
    if key in state_dict:
        return state_dict[key]
    module_key = f"module.{key}"
    if module_key in state_dict:
        return state_dict[module_key]
    return None


def _load_weights() -> Optional[NeuMFWeights]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE

    try:
        import torch  # noqa: F401
    except Exception:
        return None

    for model_path in _candidate_paths():
        if not model_path or not os.path.exists(model_path):
            continue

        try:
            state = _load_state_dict(model_path)
            if not isinstance(state, dict):
                continue

            user_emb_mf = _find_key(state, "user_emb_mf.weight")
            item_emb_mf = _find_key(state, "item_emb_mf.weight")
            user_emb_mlp = _find_key(state, "user_emb_mlp.weight")
            item_emb_mlp = _find_key(state, "item_emb_mlp.weight")
            out_w = _find_key(state, "output_layer.weight")
            out_b = _find_key(state, "output_layer.bias")

            if any(value is None for value in [
                user_emb_mf,
                item_emb_mf,
                user_emb_mlp,
                item_emb_mlp,
                out_w,
                out_b,
            ]):
                continue

            layer_indices = []
            for key in state.keys():
                normalized = key.replace("module.", "")
                match = re.fullmatch(r"mlp\.(\d+)\.weight", normalized)
                if match:
                    layer_indices.append(int(match.group(1)))
            layer_indices = sorted(layer_indices)

            mlp_layers: List[Tuple[np.ndarray, np.ndarray]] = []
            for layer_idx in layer_indices:
                weight = _find_key(state, f"mlp.{layer_idx}.weight")
                bias = _find_key(state, f"mlp.{layer_idx}.bias")
                if weight is None or bias is None:
                    continue
                mlp_layers.append((_to_numpy(weight), _to_numpy(bias)))

            user_id_map, movie_id_map = _load_id_maps_from_mf()
            if user_id_map:
                max_user_idx = max(user_id_map.values())
                if max_user_idx >= _to_numpy(user_emb_mf).shape[0]:
                    user_id_map = {}
            if movie_id_map:
                max_movie_idx = max(movie_id_map.values())
                if max_movie_idx >= _to_numpy(item_emb_mf).shape[0]:
                    movie_id_map = {}

            _CACHE = NeuMFWeights(
                user_emb_mf=_to_numpy(user_emb_mf),
                item_emb_mf=_to_numpy(item_emb_mf),
                user_emb_mlp=_to_numpy(user_emb_mlp),
                item_emb_mlp=_to_numpy(item_emb_mlp),
                mlp_layers=mlp_layers,
                out_w=_to_numpy(out_w),
                out_b=_to_numpy(out_b),
                user_id_map=user_id_map,
                movie_id_map=movie_id_map,
            )
            return _CACHE
        except Exception:
            continue

    return None


def _sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def _top_contributions(values: np.ndarray, top_k: int = 5) -> List[Tuple[int, float]]:
    if values.size == 0:
        return []
    count = min(top_k, int(values.size))
    indices = np.argsort(np.abs(values))[-count:][::-1]
    return [(int(index), float(values[index])) for index in indices]


def _map_item_id(weights: NeuMFWeights, movie_id: int) -> Optional[int]:
    if weights.movie_id_map:
        idx = weights.movie_id_map.get(int(movie_id))
        if idx is not None and 0 <= idx < weights.item_emb_mf.shape[0]:
            return idx

    idx = movie_id - 1
    if idx < 0 or idx >= weights.item_emb_mf.shape[0]:
        return None
    return idx


def _map_user_id(weights: NeuMFWeights, user_id: Optional[str]) -> Optional[int]:
    if user_id is None:
        return None

    try:
        raw_user_id = int(user_id)
    except ValueError:
        return None

    if weights.user_id_map:
        idx = weights.user_id_map.get(raw_user_id)
        if idx is not None and 0 <= idx < weights.user_emb_mf.shape[0]:
            return idx

    idx = raw_user_id - 1
    if idx < 0 or idx >= weights.user_emb_mf.shape[0]:
        return None
    return idx


def _build_user_representation(
    weights: NeuMFWeights,
    user_id: Optional[str],
    liked_movie_ids: Iterable[int],
    disliked_movie_ids: Iterable[int],
) -> Tuple[np.ndarray, np.ndarray, str]:
    mapped_user = _map_user_id(weights, user_id)
    if mapped_user is not None:
        return (
            weights.user_emb_mf[mapped_user],
            weights.user_emb_mlp[mapped_user],
            "neural cf (explicit user embedding)",
        )

    liked_indices = [
        idx
        for idx in (_map_item_id(weights, movie_id) for movie_id in liked_movie_ids)
        if idx is not None
    ]
    disliked_indices = [
        idx
        for idx in (_map_item_id(weights, movie_id) for movie_id in disliked_movie_ids)
        if idx is not None
    ]

    if liked_indices:
        user_mf = weights.item_emb_mf[liked_indices].mean(axis=0)
        user_mlp = weights.item_emb_mlp[liked_indices].mean(axis=0)
        if disliked_indices:
            user_mf = user_mf - 0.5 * weights.item_emb_mf[disliked_indices].mean(axis=0)
            user_mlp = user_mlp - 0.5 * weights.item_emb_mlp[disliked_indices].mean(axis=0)
        return user_mf.astype(np.float32), user_mlp.astype(np.float32), "neural cf (profile inferred from likes)"

    return (
        weights.user_emb_mf.mean(axis=0).astype(np.float32),
        weights.user_emb_mlp.mean(axis=0).astype(np.float32),
        "neural cf (global user prior)",
    )


def _forward_score(
    weights: NeuMFWeights,
    user_mf: np.ndarray,
    user_mlp: np.ndarray,
    item_idx: int,
) -> Tuple[float, List[Tuple[int, float]]]:
    item_mf = weights.item_emb_mf[item_idx]
    item_mlp = weights.item_emb_mlp[item_idx]

    mf_part = user_mf * item_mf

    x = np.concatenate([user_mlp, item_mlp], axis=0).astype(np.float32)
    for layer_w, layer_b in weights.mlp_layers:
        x = (x @ layer_w.T) + layer_b
        x = np.maximum(x, 0.0)

    out_w = weights.out_w.reshape(-1)
    mf_contrib = mf_part * out_w[: mf_part.shape[0]]

    final_in = np.concatenate([mf_part, x], axis=0)
    logit = float(final_in @ out_w + float(weights.out_b.reshape(-1)[0]))
    return _sigmoid(logit), _top_contributions(mf_contrib)


def score_movies(
    user_id: Optional[str],
    candidate_movie_ids: Iterable[int],
    liked_movie_ids: Iterable[int],
    disliked_movie_ids: Iterable[int],
) -> Tuple[Dict[int, float], str, Dict[int, List[Tuple[int, float]]]]:
    weights = _load_weights()
    if weights is None:
        return {}, "neural cf unavailable (weights/torch missing)", {}

    user_mf, user_mlp, reason = _build_user_representation(
        weights,
        user_id,
        liked_movie_ids,
        disliked_movie_ids,
    )

    scores: Dict[int, float] = {}
    latent_by_movie: Dict[int, List[Tuple[int, float]]] = {}
    for movie_id in candidate_movie_ids:
        idx = _map_item_id(weights, int(movie_id))
        if idx is None:
            continue
        score, latent = _forward_score(weights, user_mf, user_mlp, idx)
        int_movie_id = int(movie_id)
        scores[int_movie_id] = score
        latent_by_movie[int_movie_id] = latent

    return scores, reason, latent_by_movie
