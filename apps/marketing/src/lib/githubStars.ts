const REPOSITORY_API_URL = "https://api.github.com/repos/pingdotgg/t3code";
// Shown when a build can't read the count, such as a rate limit on a shared builder IP.
const FALLBACK_STARS = "38.9k";
const REQUEST_TIMEOUT_MS = 5_000;

// Rounds down so the site never claims more stars than the repository has.
function formatStars(count: number) {
  return `${Math.floor(count / 100) / 10}k`;
}

export async function fetchGitHubStars() {
  try {
    const response = await fetch(REPOSITORY_API_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
    const { stargazers_count: count } = await response.json();
    if (typeof count !== "number") throw new Error("GitHub API response has no star count");
    return formatStars(count);
  } catch (error) {
    console.warn(`Using fallback GitHub star count ${FALLBACK_STARS}:`, error);
    return FALLBACK_STARS;
  }
}
