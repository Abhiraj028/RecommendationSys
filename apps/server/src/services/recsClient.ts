const baseUrl = process.env.RECS_SERVICE_URL || "http://localhost:8000";

const buildUrl = (path: string) => `${baseUrl}${path}`;

export const postJson = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(buildUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Recommender error ${res.status}: ${text}`);
  }

  return (await res.json()) as T;
};
