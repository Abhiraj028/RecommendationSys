import { useEffect, useMemo, useRef, useState } from "react";

type MovieSummary = {
  movieId: number;
  title: string;
  genres: string[];
  posterUrl?: string | null;
  thumbnailUrl?: string | null;
};

type RecommendationModel =
  | "baseline"
  | "user-user"
  | "item-item"
  | "matrix-cf"
  | "neural-cf";

type RecommendationItem = {
  movieId: number;
  score: number;
  reason: string;
};

type RecommendationRow = {
  model: RecommendationModel;
  items: RecommendationItem[];
};

const MODELS: RecommendationModel[] = [
  "baseline",
  "user-user",
  "item-item",
  "matrix-cf",
  "neural-cf",
];

const STORAGE_KEY = "recs.user.state";

const apiBase = (import.meta.env.VITE_API_BASE as string | undefined) ||
  "http://127.0.0.1:4000";

const buildUrl = (path: string) => `${apiBase.replace(/\/$/, "")}${path}`;

const labelForModel = (model: RecommendationModel) => {
  switch (model) {
    case "baseline":
      return "Baseline Bias";
    case "user-user":
      return "User-User CF";
    case "item-item":
      return "Item-Item CF";
    case "matrix-cf":
      return "Matrix CF";
    case "neural-cf":
      return "Neural CF";
    default:
      return model;
  }
};

const fetchJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(buildUrl(path), init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Request failed");
  }
  return (await response.json()) as T;
};

const loadStoredState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { liked: [], disliked: [] };
    }
    const parsed = JSON.parse(raw) as {
      liked: number[];
      disliked: number[];
    };
    return {
      liked: parsed.liked || [],
      disliked: parsed.disliked || [],
    };
  } catch {
    return { liked: [], disliked: [] };
  }
};

const extractYear = (title: string) => {
  const match = title.match(/\((\d{4})\)\s*$/);
  return match ? Number(match[1]) : null;
};

const cleanTitle = (title: string) => title.replace(/\s*\(\d{4}\)\s*$/, "").trim();

function App() {
  const [popular, setPopular] = useState<MovieSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MovieSummary[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [likedMovieIds, setLikedMovieIds] = useState<number[]>([]);
  const [dislikedMovieIds, setDislikedMovieIds] = useState<number[]>([]);
  const [rows, setRows] = useState<RecommendationRow[]>([]);
  const [movieMap, setMovieMap] = useState<Record<number, MovieSummary>>({});
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle"
  );
  const remainingLikes = Math.max(0, 5 - likedMovieIds.length);
  const [apiStatus, setApiStatus] = useState<"checking" | "ok" | "down">("checking");
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const likedSet = useMemo(() => new Set(likedMovieIds), [likedMovieIds]);
  const dislikedSet = useMemo(() => new Set(dislikedMovieIds), [dislikedMovieIds]);

  const likedPreview = useMemo(() => {
    return likedMovieIds
      .map((id) => movieMap[id])
      .filter((movie): movie is MovieSummary => Boolean(movie))
      .slice(0, 5);
  }, [likedMovieIds, movieMap]);

  useEffect(() => {
    const stored = loadStoredState();
    setLikedMovieIds(stored.liked);
    setDislikedMovieIds(stored.disliked);
  }, []);

  useEffect(() => {
    fetchJson<{ ok: boolean }>("/health")
      .then(() => setApiStatus("ok"))
      .catch(() => setApiStatus("down"));
  }, []);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ liked: likedMovieIds, disliked: dislikedMovieIds })
    );
  }, [likedMovieIds, dislikedMovieIds]);

  useEffect(() => {
    fetchJson<{ items: MovieSummary[] }>("/api/movies/popular?limit=20")
      .then((data) => {
        setPopular(data.items);
        const merged: Record<number, MovieSummary> = {};
        data.items.forEach((item) => {
          merged[item.movieId] = item;
        });
        setMovieMap((prev) => ({ ...prev, ...merged }));
      })
      .catch(() => {
        setPopular([]);
      });
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (!searchQuery.trim()) {
        setSearchResults([]);
        setSearchLoading(false);
        setDropdownOpen(false);
        return;
      }

      setSearchLoading(true);
      fetchJson<{ items: MovieSummary[] }>(
        `/api/movies/search?q=${encodeURIComponent(searchQuery)}&limit=18`
      )
        .then((data) => {
          setSearchResults(data.items);
          setSearchLoading(false);
          const merged: Record<number, MovieSummary> = {};
          data.items.forEach((item) => {
            merged[item.movieId] = item;
          });
          setMovieMap((prev) => ({ ...prev, ...merged }));
        })
        .catch(() => {
          setSearchResults([]);
          setSearchLoading(false);
        });
    }, 350);

    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  useEffect(() => {
    if (!dropdownOpen) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      if (!dropdownRef.current) {
        return;
      }
      if (!dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  const toggleLike = (movieId: number) => {
    setLikedMovieIds((prev) =>
      prev.includes(movieId) ? prev.filter((id) => id !== movieId) : [...prev, movieId]
    );
    setDislikedMovieIds((prev) => prev.filter((id) => id !== movieId));
  };

  const toggleDislike = (movieId: number) => {
    setDislikedMovieIds((prev) =>
      prev.includes(movieId) ? prev.filter((id) => id !== movieId) : [...prev, movieId]
    );
    setLikedMovieIds((prev) => prev.filter((id) => id !== movieId));
  };

  const loadRows = async () => {
    setStatus("loading");
    try {
      const response = await fetchJson<{ rows: RecommendationRow[] }>(
        "/api/recommendations/rows",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            models: MODELS,
            likedMovieIds,
            dislikedMovieIds,
            limit: 12,
          }),
        }
      );

      setRows(response.rows);

      const ids = new Set<number>();
      response.rows.forEach((row) => row.items.forEach((item) => ids.add(item.movieId)));

      if (ids.size) {
        const query = Array.from(ids).join(",");
        const movies = await fetchJson<{ items: MovieSummary[] }>(
          `/api/movies?ids=${encodeURIComponent(query)}`
        );
        const merged: Record<number, MovieSummary> = {};
        movies.items.forEach((item) => {
          merged[item.movieId] = item;
        });
        setMovieMap((prev) => ({ ...prev, ...merged }));
      }

      setStatus("ready");
    } catch {
      setStatus("error");
    }
  };

  const clearAll = () => {
    setLikedMovieIds([]);
    setDislikedMovieIds([]);
    setRows([]);
    setStatus("idle");
  };

  return (
    <div className="canvas">
      {remainingLikes > 0 && (
        <div className="float-hint">
          Pick {remainingLikes} more {remainingLikes === 1 ? "movie" : "movies"} to
          generate rows.
        </div>
      )}
      <div className="topbar">
        <div className="topbar-left">
          <span className={`badge badge-${apiStatus}`}>
            {apiStatus === "checking" && "Warming up"}
            {apiStatus === "ok" && "Live signal"}
            {apiStatus === "down" && "Offline"}
          </span>
          <span className="stamp">CUTLIST LAB</span>
        </div>
        <div className="topbar-right">MovieLens latest-small · Five models</div>
      </div>

      <header className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">Cold-start cinema for restless taste.</p>
          <h1>Cutlist</h1>
          <p className="lead">
            Shape a quick profile in five taps. We run five different recommenders on the
            same signal so you can feel the differences.
          </p>
          <div className="ticker">
            {likedPreview.length === 0 && <span>Pick something. The feed adapts.</span>}
            {likedPreview.map((movie) => (
              <span key={`liked-${movie.movieId}`} className="ticker-chip">
                {cleanTitle(movie.title)}
              </span>
            ))}
          </div>
        </div>
        <div className="hero-stack">
          <div className="stat-card">
            <div className="stat">
              <span>Liked</span>
              <strong>{likedMovieIds.length}</strong>
            </div>
            <div className="stat">
              <span>Disliked</span>
              <strong>{dislikedMovieIds.length}</strong>
            </div>
          </div>
          <div className="control-card">
            <button
              className="primary"
              disabled={likedMovieIds.length < 5 || status === "loading"}
              onClick={loadRows}
            >
              {status === "loading" ? "Running models" : "Generate rows"}
            </button>
            <button className="ghost" onClick={clearAll}>
              Reset picks
            </button>
            <p className="hint">Cold-start list ordered by highest average rating.</p>
          </div>
        </div>
      </header>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Cold Start Picks</h2>
            <p>Tap again to undo. Use search to inject any title.</p>
          </div>
          <span className="section-tag">Highest avg rating</span>
        </div>
        <div className="search-shell">
          <div className="search-input">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onFocus={() => setDropdownOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && searchResults.length > 0) {
                  toggleLike(searchResults[0].movieId);
                  setDropdownOpen(false);
                }
              }}
              placeholder="Search any title"
            />
            <span className="search-tip">Instant add</span>
          </div>
          {dropdownOpen && (searchLoading || searchResults.length > 0 || searchQuery.trim()) && (
            <div className="dropdown" ref={dropdownRef}>
              {searchLoading && <div className="dropdown-item">Searching...</div>}
              {!searchLoading && searchResults.length === 0 && (
                <div className="dropdown-item">No matches</div>
              )}
              {!searchLoading &&
                searchResults.map((movie) => (
                  <button
                    key={`result-${movie.movieId}`}
                    className="dropdown-item"
                    onClick={() => toggleLike(movie.movieId)}
                  >
                    <div className="dropdown-poster">
                      {movie.posterUrl ? (
                        <img src={movie.posterUrl} alt={movie.title} />
                      ) : (
                        <span>No Poster</span>
                      )}
                    </div>
                    <div className="dropdown-info">
                      <span>{movie.title}</span>
                      <em>{movie.genres.join(" · ") || "Unclassified"}</em>
                    </div>
                    <div className="dropdown-actions">
                      <button
                        type="button"
                        className={`pill ${likedSet.has(movie.movieId) ? "active" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleLike(movie.movieId);
                        }}
                      >
                        Like
                      </button>
                      <button
                        type="button"
                        className={`pill ${dislikedSet.has(movie.movieId) ? "active" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleDislike(movie.movieId);
                        }}
                      >
                        Dislike
                      </button>
                    </div>
                  </button>
                ))}
            </div>
          )}
        </div>
        <div className="gallery">
          {popular.map((movie) => (
            <MovieCard
              key={`popular-${movie.movieId}`}
              movie={movie}
              liked={likedSet.has(movie.movieId)}
              disliked={dislikedSet.has(movie.movieId)}
              onLike={() => toggleLike(movie.movieId)}
              onDislike={() => toggleDislike(movie.movieId)}
            />
          ))}
        </div>
      </section>

      <section className="section rows">
        <div className="section-head">
          <div>
            <h2>Model Rows</h2>
            <p>Same signal. Different engines.</p>
          </div>
        </div>
        {status === "error" && (
          <div className="error">Could not load recommendations. Try again.</div>
        )}
        {rows.length === 0 && status !== "loading" && (
          <div className="empty">Pick 5 movies and hit “Generate rows”.</div>
        )}
        {rows.map((row) => (
          <div key={row.model} className="row-block">
            <div className="row-head">
              <h3>{labelForModel(row.model)}</h3>
              <span className="tag">{row.items.length} picks</span>
            </div>
            <div className="row-scroll">
              {row.items.map((item) => {
                const movie = movieMap[item.movieId];
                if (!movie) {
                  return null;
                }
                return (
                  <MovieCard
                    key={`${row.model}-${item.movieId}`}
                    movie={movie}
                    liked={likedSet.has(movie.movieId)}
                    disliked={dislikedSet.has(movie.movieId)}
                    onLike={() => toggleLike(movie.movieId)}
                    onDislike={() => toggleDislike(movie.movieId)}
                    compact
                  />
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

type MovieCardProps = {
  movie: MovieSummary;
  liked: boolean;
  disliked: boolean;
  compact?: boolean;
  onLike: () => void;
  onDislike: () => void;
};

const MovieCard = ({
  movie,
  liked,
  disliked,
  compact,
  onLike,
  onDislike,
}: MovieCardProps) => {
  const year = extractYear(movie.title);
  return (
    <article className={`film-card ${compact ? "compact" : ""}`}>
      <div className={`film-poster ${liked ? "liked" : ""} ${disliked ? "disliked" : ""}`}>
        {movie.posterUrl ? (
          <img src={movie.posterUrl} alt={movie.title} />
        ) : (
          <div className="poster-fallback">No Poster</div>
        )}
        <div className="poster-actions">
          <button className={`pill ${liked ? "active" : ""}`} onClick={onLike}>
            Like
          </button>
          <button className={`pill ${disliked ? "active" : ""}`} onClick={onDislike}>
            Dislike
          </button>
        </div>
      </div>
      <div className="card-body">
        <div className="title-row">
          <h4>{cleanTitle(movie.title)}</h4>
          {year ? <span className="year">{year}</span> : null}
        </div>
        <p className="genres">{movie.genres.join(" · ") || "Unclassified"}</p>
      </div>
    </article>
  );
};

export default App;
