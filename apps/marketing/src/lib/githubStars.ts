const REPOSITORY_API_URL = "https://api.github.com/repos/pingdotgg/t3code";
// Offline development can still render without publishing a stale production count.
const FALLBACK_STARS = "38.9k";
const REQUEST_TIMEOUT_MS = 5_000;

// Rounds down so the site never claims more stars than the repository has.
function formatStars(count: number) {
  return count < 1000 ? String(count) : `${Math.floor(count / 100) / 10}k`;
}

export async function fetchGitHubStars() {
  const token = process.env.GITHUB_TOKEN;
  try {
    const response = await fetch(REPOSITORY_API_URL, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
    const { stargazers_count: count } = await response.json();
    if (typeof count !== "number") throw new Error("GitHub API response has no star count");
    return formatStars(count);
  } catch (error) {
    if (import.meta.env.PROD) throw new Error("Could not fetch GitHub stars", { cause: error });
    console.warn(`Using fallback GitHub star count ${FALLBACK_STARS}:`, error);
    return FALLBACK_STARS;
  }
}
