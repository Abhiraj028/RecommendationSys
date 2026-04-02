import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";

type MovieSummary = {
  movieId: number;
  title: string;
  genres: string[];
  posterUrl?: string | null;
  thumbnailUrl?: string | null;
};

type MovieDetails = {
  overview?: string | null;
  releaseDate?: string | null;
  voteAverage?: number | null;
  voteCount?: number | null;
  backdropUrl?: string | null;
};

type MovieLensStats = {
  ratingAvg?: number | null;
  ratingCount?: number | null;
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

type AnalyticsOverview = {
  counts: { users: number; movies: number; ratings: number };
  ratingDistribution: Array<{ label: string; count: number }>;
  ratingsPerUser: {
    min: number;
    avg: number;
    max: number;
    bins: Array<{ label: string; count: number }>;
  };
  ratingsPerMovie: {
    min: number;
    avg: number;
    max: number;
    bins: Array<{ label: string; count: number }>;
  };
  moviePopularity: {
    tail: number[];
    top: Array<{ movieId: number; title: string; ratingCount: number; ratingAvg: number }>;
    topRated: Array<{ movieId: number; title: string; ratingCount: number; ratingAvg: number }>;
    worstRated: Array<{ movieId: number; title: string; ratingCount: number; ratingAvg: number }>;
  };
  sparsity: number;
  sparsityChart: Array<{ label: string; count: number }>;
  sparsityMatrix: { rows: number; cols: number; cells: number[] };
  ratingThreshold: number;
  bias: {
    globalMean: number;
    userMin: number;
    userMax: number;
    movieMin: number;
    movieMax: number;
    userBins: Array<{ label: string; count: number }>;
    movieBins: Array<{ label: string; count: number }>;
  };
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

const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);

const formatPercent = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 }).format(
    value
  );

const shuffleList = <T,>(items: T[]) => {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
};

function App() {
  const [likedMovieIds, setLikedMovieIds] = useState<number[]>([]);
  const [dislikedMovieIds, setDislikedMovieIds] = useState<number[]>([]);
  const [movieMap, setMovieMap] = useState<Record<number, MovieSummary>>({});
  const [apiStatus, setApiStatus] = useState<"checking" | "ok" | "down">("checking");
  const [activeMovie, setActiveMovie] = useState<MovieSummary | null>(null);
  const [modalDetails, setModalDetails] = useState<MovieDetails | null>(null);
  const [modalStats, setModalStats] = useState<MovieLensStats | null>(null);
  const [modalStatus, setModalStatus] = useState<"idle" | "loading" | "error">("idle");

  const likedSet = useMemo(() => new Set(likedMovieIds), [likedMovieIds]);
  const dislikedSet = useMemo(() => new Set(dislikedMovieIds), [dislikedMovieIds]);

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
    if (!activeMovie) {
      return;
    }

    let cancelled = false;
    setModalStatus("loading");
    setModalDetails(null);
    setModalStats(null);

    fetchJson<{ movie: MovieSummary; tmdb: MovieDetails | null; movieLens: MovieLensStats }>(
      `/api/movies/${activeMovie.movieId}/details`
    )
      .then((detailsResponse) => {
        if (cancelled) {
          return;
        }
        if (detailsResponse.movie) {
          setMovieMap((prev) => ({
            ...prev,
            [detailsResponse.movie.movieId]: detailsResponse.movie,
          }));
          setActiveMovie(detailsResponse.movie);
        }
        setModalDetails(detailsResponse.tmdb);
        setModalStats(detailsResponse.movieLens ?? null);
        setModalStatus("idle");
      })
      .catch(() => {
        if (!cancelled) {
          setModalStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeMovie?.movieId]);

  const updateMovieMap = useCallback((items: MovieSummary[]) => {
    const merged: Record<number, MovieSummary> = {};
    items.forEach((item) => {
      merged[item.movieId] = item;
    });
    setMovieMap((prev) => ({ ...prev, ...merged }));
  }, []);

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

  const resetSelections = useCallback(() => {
    setLikedMovieIds([]);
    setDislikedMovieIds([]);
  }, []);

  const openMovie = (movie: MovieSummary) => {
    setActiveMovie(movie);
  };

  const closeMovie = () => {
    setActiveMovie(null);
    setModalDetails(null);
    setModalStats(null);
    setModalStatus("idle");
  };

  return (
    <div className="canvas">
      <div className="topbar">
        <div className="topbar-left">
          <span className={`badge badge-${apiStatus}`}>
            {apiStatus === "checking" && "Warming up"}
            {apiStatus === "ok" && "Live signal"}
            {apiStatus === "down" && "Offline"}
          </span>
          <span className="stamp">CUTLIST LAB</span>
        </div>
        <div className="topbar-right">
          <nav className="topnav">
            <Link to="/">Home</Link>
            <Link to="/analytics">Analytics</Link>
          </nav>
          <span>MovieLens latest-small · Five models</span>
        </div>
      </div>

      <Routes>
        <Route
          path="/"
          element={
            <HomePage
              likedMovieIds={likedMovieIds}
              dislikedMovieIds={dislikedMovieIds}
              likedSet={likedSet}
              dislikedSet={dislikedSet}
              movieMap={movieMap}
              onUpdateMovieMap={updateMovieMap}
              onLike={toggleLike}
              onDislike={toggleDislike}
              onReset={resetSelections}
              onOpen={openMovie}
            />
          }
        />
        <Route
          path="/search"
          element={
            <SearchPage
              likedSet={likedSet}
              dislikedSet={dislikedSet}
              onUpdateMovieMap={updateMovieMap}
              onLike={toggleLike}
              onDislike={toggleDislike}
              onOpen={openMovie}
            />
          }
        />
        <Route path="/analytics" element={<AnalyticsPage />} />
      </Routes>

      <MovieModal
        movie={activeMovie}
        details={modalDetails}
        stats={modalStats}
        status={modalStatus}
        onClose={closeMovie}
      />
    </div>
  );
}

type HomePageProps = {
  likedMovieIds: number[];
  dislikedMovieIds: number[];
  likedSet: Set<number>;
  dislikedSet: Set<number>;
  movieMap: Record<number, MovieSummary>;
  onUpdateMovieMap: (items: MovieSummary[]) => void;
  onLike: (movieId: number) => void;
  onDislike: (movieId: number) => void;
  onReset: () => void;
  onOpen: (movie: MovieSummary) => void;
};

const HomePage = ({
  likedMovieIds,
  dislikedMovieIds,
  likedSet,
  dislikedSet,
  movieMap,
  onUpdateMovieMap,
  onLike,
  onDislike,
  onReset,
  onOpen,
}: HomePageProps) => {
  const [popular, setPopular] = useState<MovieSummary[]>([]);
  const [popularPool, setPopularPool] = useState<MovieSummary[]>([]);
  const [rows, setRows] = useState<RecommendationRow[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle"
  );
  const [searchDraft, setSearchDraft] = useState("");
  const remainingLikes = Math.max(0, 5 - likedMovieIds.length);
  const navigate = useNavigate();

  const likedPreview = useMemo(() => {
    return likedMovieIds
      .map((id) => movieMap[id])
      .filter((movie): movie is MovieSummary => Boolean(movie))
      .slice(0, 5);
  }, [likedMovieIds, movieMap]);

  useEffect(() => {
    fetchJson<{ items: MovieSummary[] }>("/api/movies/popular?limit=200")
      .then((data) => {
        setPopularPool(data.items);
        setPopular(shuffleList(data.items).slice(0, 20));
        onUpdateMovieMap(data.items);
      })
      .catch(() => {
        setPopular([]);
      });
  }, [onUpdateMovieMap]);

  const reshufflePopular = () => {
    if (!popularPool.length) {
      return;
    }
    setPopular(shuffleList(popularPool).slice(0, 20));
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
        onUpdateMovieMap(movies.items);
      }

      setStatus("ready");
    } catch {
      setStatus("error");
    }
  };

  const clearAll = () => {
    onReset();
    setRows([]);
    setStatus("idle");
  };

  const handleSearchSubmit = (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <>
      {remainingLikes > 0 && (
        <div className="float-hint">
          Pick {remainingLikes} more {remainingLikes === 1 ? "movie" : "movies"} to
          generate rows.
        </div>
      )}
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
          <div className="section-actions">
            <span className="section-tag">Highest avg rating</span>
            <button type="button" className="section-action" onClick={reshufflePopular}>
              Shuffle
            </button>
          </div>
        </div>
        <SearchForm
          value={searchDraft}
          placeholder="Search any title"
          onChange={setSearchDraft}
          onSubmit={handleSearchSubmit}
        />
        <div className="gallery">
          {popular.map((movie) => (
            <MovieCard
              key={`popular-${movie.movieId}`}
              movie={movie}
              liked={likedSet.has(movie.movieId)}
              disliked={dislikedSet.has(movie.movieId)}
              onLike={() => onLike(movie.movieId)}
              onDislike={() => onDislike(movie.movieId)}
              onOpen={() => onOpen(movie)}
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
                    onLike={() => onLike(movie.movieId)}
                    onDislike={() => onDislike(movie.movieId)}
                    onOpen={() => onOpen(movie)}
                    compact
                  />
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </>
  );
};

type SearchPageProps = {
  likedSet: Set<number>;
  dislikedSet: Set<number>;
  onUpdateMovieMap: (items: MovieSummary[]) => void;
  onLike: (movieId: number) => void;
  onDislike: (movieId: number) => void;
  onOpen: (movie: MovieSummary) => void;
};

const SearchPage = ({
  likedSet,
  dislikedSet,
  onUpdateMovieMap,
  onLike,
  onDislike,
  onOpen,
}: SearchPageProps) => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryParam = searchParams.get("q") ?? "";
  const [draft, setDraft] = useState(queryParam);
  const [results, setResults] = useState<MovieSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(queryParam);
  }, [queryParam]);

  useEffect(() => {
    const trimmed = queryParam.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchJson<{ items: MovieSummary[] }>(
      `/api/movies/search?q=${encodeURIComponent(trimmed)}&limit=60`
    )
      .then((data) => {
        if (cancelled) {
          return;
        }
        setResults(data.items);
        onUpdateMovieMap(data.items);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setResults([]);
        setLoading(false);
        setError("Search failed.");
      });

    return () => {
      cancelled = true;
    };
  }, [queryParam, onUpdateMovieMap]);

  const handleSubmit = (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <section className="section search-page">
      <div className="section-head">
        <div>
          <h2>Search Results</h2>
          <p>
            {queryParam.trim()
              ? `Showing matches for “${queryParam.trim()}”.`
              : "Search for any MovieLens title."}
          </p>
        </div>
        <span className="section-tag">Explore catalog</span>
      </div>
      <SearchForm
        value={draft}
        placeholder="Search titles"
        onChange={setDraft}
        onSubmit={handleSubmit}
      />
      {loading && <div className="empty">Searching...</div>}
      {error && <div className="error">{error}</div>}
      {!loading && !error && results.length === 0 && queryParam.trim() && (
        <div className="empty">No matches. Try a different title.</div>
      )}
      <div className="gallery">
        {results.map((movie) => (
          <MovieCard
            key={`search-${movie.movieId}`}
            movie={movie}
            liked={likedSet.has(movie.movieId)}
            disliked={dislikedSet.has(movie.movieId)}
            onLike={() => onLike(movie.movieId)}
            onDislike={() => onDislike(movie.movieId)}
            onOpen={() => onOpen(movie)}
          />
        ))}
      </div>
    </section>
  );
};

const AnalyticsPage = () => {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    fetchJson<AnalyticsOverview>("/api/analytics/overview")
      .then((data) => {
        setOverview(data);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, []);

  if (status === "loading") {
    return <div className="section">Loading analytics...</div>;
  }

  if (status === "error" || !overview) {
    return <div className="section error">Analytics could not be loaded.</div>;
  }

  return (
    <section className="section analytics">
      <div className="section-head">
        <div>
          <h2>Dataset Analytics</h2>
          <p>EDA snapshot based on MovieLens ratings and metadata.</p>
        </div>
        <span className="section-tag">Exploratory</span>
      </div>

      <div className="stat-grid">
        <div className="stat-tile">
          <span>Users</span>
          <strong>{formatNumber(overview.counts.users)}</strong>
        </div>
        <div className="stat-tile">
          <span>Movies</span>
          <strong>{formatNumber(overview.counts.movies)}</strong>
        </div>
        <div className="stat-tile">
          <span>Ratings</span>
          <strong>{formatNumber(overview.counts.ratings)}</strong>
        </div>
        <div className="stat-tile">
          <span>Sparsity</span>
          <strong>{formatPercent(overview.sparsity)}</strong>
        </div>
      </div>

      <div className="analytics-grid">
        <ChartCard title="Rating Scale" subtitle="Count per rating value">
          <BarChart data={overview.ratingDistribution} />
        </ChartCard>
        <ChartCard title="User Activity" subtitle="Ratings per user histogram">
          <BarChart data={overview.ratingsPerUser.bins} />
          <div className="stat-line">
            <span>Min</span>
            <strong>{formatNumber(overview.ratingsPerUser.min)}</strong>
            <span>Avg</span>
            <strong>{overview.ratingsPerUser.avg.toFixed(2)}</strong>
            <span>Max</span>
            <strong>{formatNumber(overview.ratingsPerUser.max)}</strong>
          </div>
        </ChartCard>
        <ChartCard title="Movie Coverage" subtitle="Ratings per movie histogram">
          <BarChart data={overview.ratingsPerMovie.bins} />
          <div className="stat-line">
            <span>Min</span>
            <strong>{formatNumber(overview.ratingsPerMovie.min)}</strong>
            <span>Avg</span>
            <strong>{overview.ratingsPerMovie.avg.toFixed(2)}</strong>
            <span>Max</span>
            <strong>{formatNumber(overview.ratingsPerMovie.max)}</strong>
          </div>
        </ChartCard>
        <ChartCard title="Bias Distributions" subtitle="User vs movie mean ratings">
          <div className="bias-grid">
            <div>
              <h4>User Means</h4>
              <BarChart data={overview.bias.userBins} />
            </div>
            <div>
              <h4>Movie Means</h4>
              <BarChart data={overview.bias.movieBins} />
            </div>
          </div>
          <div className="stat-line">
            <span>Global Avg</span>
            <strong>{overview.bias.globalMean.toFixed(2)}</strong>
            <span>User Min</span>
            <strong>{overview.bias.userMin.toFixed(2)}</strong>
            <span>User Max</span>
            <strong>{overview.bias.userMax.toFixed(2)}</strong>
          </div>
          <div className="stat-line">
            <span>Movie Min</span>
            <strong>{overview.bias.movieMin.toFixed(2)}</strong>
            <span>Movie Max</span>
            <strong>{overview.bias.movieMax.toFixed(2)}</strong>
          </div>
        </ChartCard>
        <ChartCard title="Sparsity Breakdown" subtitle="Rated vs missing entries">
          <BarChart data={overview.sparsityChart} />
        </ChartCard>
        <ChartCard
          title="Sparsity Matrix"
          subtitle={`Random ${overview.sparsityMatrix.rows}x${overview.sparsityMatrix.cols} sample`}
        >
          <SparsityMatrix matrix={overview.sparsityMatrix} />
          <div className="matrix-legend">
            <span className="legend-chip filled" />
            <span>Rated</span>
            <span className="legend-chip" />
            <span>Missing</span>
          </div>
        </ChartCard>
        <ChartCard title="Most Rated Movies" subtitle="Highest rating volume">
          <div className="top-list">
            {overview.moviePopularity.top.map((movie) => (
              <div key={movie.movieId} className="top-item">
                <div>
                  <strong>{cleanTitle(movie.title)}</strong>
                  <span>{formatNumber(movie.ratingCount)} ratings</span>
                </div>
                <em>{movie.ratingAvg.toFixed(2)}</em>
              </div>
            ))}
          </div>
        </ChartCard>
        <ChartCard
          title="Top Rated Movies"
          subtitle={`Highest averages (min ${overview.ratingThreshold} ratings)`}
        >
          <RankedList items={overview.moviePopularity.topRated} />
        </ChartCard>
        <ChartCard
          title="Worst Rated Movies"
          subtitle={`Lowest averages (min ${overview.ratingThreshold} ratings)`}
        >
          <RankedList items={overview.moviePopularity.worstRated} />
        </ChartCard>
      </div>
    </section>
  );
};

type SearchFormProps = {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
};

const SearchForm = ({ value, placeholder, onChange, onSubmit }: SearchFormProps) => (
  <form
    className="search-shell"
    onSubmit={(event) => {
      event.preventDefault();
      onSubmit(value);
    }}
  >
    <div className="search-input">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      <button type="submit" className="search-submit">
        Search
      </button>
    </div>
  </form>
);

type ChartCardProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
};

const ChartCard = ({ title, subtitle, children }: ChartCardProps) => (
  <div className="chart-card">
    <div className="chart-head">
      <h3>{title}</h3>
      {subtitle ? <p>{subtitle}</p> : null}
    </div>
    {children}
  </div>
);

type BarChartProps = {
  data: Array<{ label: string; count: number }>;
};

const BarChart = ({ data }: BarChartProps) => {
  const max = Math.max(1, ...data.map((item) => item.count));
  return (
    <div className="chart-bars">
      {data.map((item) => (
        <div key={item.label} className="chart-bar">
          <span>{item.label}</span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ width: `${(item.count / max) * 100}%` }}
            />
          </div>
          <em>{formatNumber(item.count)}</em>
        </div>
      ))}
    </div>
  );
};

type SparklineProps = {
  data: number[];
};

const Sparkline = ({ data }: SparklineProps) => {
  if (!data.length) {
    return <div className="empty">No data.</div>;
  }
  const max = Math.max(...data);
  const denom = Math.max(1, data.length - 1);
  const points = data
    .map((value, index) => {
      const x = (index / denom) * 100;
      const y = 100 - (value / max) * 100;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polyline points={points} fill="none" />
    </svg>
  );
};

type SparsityMatrixProps = {
  matrix: { rows: number; cols: number; cells: number[] };
};

const SparsityMatrix = ({ matrix }: SparsityMatrixProps) => {
  if (!matrix.rows || !matrix.cols || !matrix.cells.length) {
    return <div className="empty">No sparsity sample available.</div>;
  }

  return (
    <div
      className="matrix-grid"
      style={{
        gridTemplateColumns: `repeat(${matrix.cols}, minmax(0, 1fr))`,
      }}
    >
      {matrix.cells.map((value, index) => (
        <span
          key={`cell-${index}`}
          className={`matrix-cell ${value ? "filled" : "empty"}`}
          aria-hidden
        />
      ))}
    </div>
  );
};

type RankedListProps = {
  items: Array<{ movieId: number; title: string; ratingCount: number; ratingAvg: number }>;
};

const RankedList = ({ items }: RankedListProps) => (
  <div className="ranked-list">
    {items.map((movie) => (
      <div key={movie.movieId} className="ranked-item">
        <div>
          <strong>{cleanTitle(movie.title)}</strong>
          <span>{formatNumber(movie.ratingCount)} ratings</span>
        </div>
        <em>{movie.ratingAvg.toFixed(2)}</em>
      </div>
    ))}
  </div>
);

type MovieModalProps = {
  movie: MovieSummary | null;
  details: MovieDetails | null;
  stats: MovieLensStats | null;
  status: "idle" | "loading" | "error";
  onClose: () => void;
};

const MovieModal = ({ movie, details, stats, status, onClose }: MovieModalProps) => {
  if (!movie) {
    return null;
  }

  const portalTarget = typeof document !== "undefined" ? document.body : null;
  if (!portalTarget) {
    return null;
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="modal-header">
          <div>
            <h3>{cleanTitle(movie.title)}</h3>
            <span>{movie.genres.join(" · ") || "Unclassified"}</span>
          </div>
          <button className="modal-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-poster">
            {movie.posterUrl ? (
              <img src={movie.posterUrl} alt={movie.title} />
            ) : (
              <div className="poster-fallback">No Poster</div>
            )}
          </div>
          <div className="modal-content">
            {status === "loading" && <div className="empty">Loading details...</div>}
            {status === "error" && (
              <div className="error">Could not load details. Try again.</div>
            )}
            {status === "idle" && (
              <>
                <div className="modal-meta">
                  <span>
                    {details?.releaseDate
                      ? `Released ${details.releaseDate}`
                      : "Release date unknown"}
                  </span>
                  {stats?.ratingAvg ? (
                    <span>
                      MovieLens {stats.ratingAvg.toFixed(2)} · {stats.ratingCount ?? 0} ratings
                    </span>
                  ) : (
                    <span>MovieLens stats unavailable</span>
                  )}
                </div>
                <p className="modal-overview">
                  {details?.overview ||
                    "No overview returned. Try another title if you need TMDB data."}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    portalTarget
  );
};

type MovieCardProps = {
  movie: MovieSummary;
  liked: boolean;
  disliked: boolean;
  compact?: boolean;
  onLike: () => void;
  onDislike: () => void;
  onOpen?: () => void;
};

const MovieCard = ({
  movie,
  liked,
  disliked,
  compact,
  onLike,
  onDislike,
  onOpen,
}: MovieCardProps) => {
  const year = extractYear(movie.title);
  const handleOpen = () => {
    if (onOpen) {
      onOpen();
    }
  };
  return (
    <article
      className={`film-card ${compact ? "compact" : ""} ${onOpen ? "clickable" : ""}`}
      onClick={handleOpen}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={(event) => {
        if (!onOpen) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleOpen();
        }
      }}
    >
      <div className={`film-poster ${liked ? "liked" : ""} ${disliked ? "disliked" : ""}`}>
        {movie.posterUrl ? (
          <img src={movie.posterUrl} alt={movie.title} loading="lazy" />
        ) : (
          <div className="poster-fallback">No Poster</div>
        )}
        <div className="poster-actions">
          <button
            className={`pill ${liked ? "active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onLike();
            }}
          >
            Like
          </button>
          <button
            className={`pill ${disliked ? "active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onDislike();
            }}
          >
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
