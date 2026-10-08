const REPOSITORY_API_URL = "https://api.github.com/repos/pingdotgg/t3code";
const CACHE_KEY = "t3code-github-stars";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

function isStarCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Fetch at runtime: the marketing site is static and can outlive its build by weeks.
export async function fetchGithubStars(): Promise<number | undefined> {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? "null");
    if (
      isStarCount(cached?.count) &&
      typeof cached?.fetchedAt === "number" &&
      cached.fetchedAt <= Date.now() &&
      Date.now() - cached.fetchedAt < CACHE_TTL_MS
    ) {
      return cached.count;
    }
  } catch {
    // Storage can be disabled or contain an invalid entry; still try GitHub.
  }

  try {
    const response = await fetch(REPOSITORY_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return undefined;
    const data = await response.json();
    if (!isStarCount(data?.stargazers_count)) return undefined;

    const count = data.stargazers_count;
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ count, fetchedAt: Date.now() }));
    } catch {
      // An unavailable cache must not hide a successfully fetched count.
    }
    return count;
  } catch {
    // Keep the GitHub link usable without showing a stale or invented count.
    return undefined;
  }
}
