export const GITHUB_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";

export const IOS_APP_STORE_URL =
  "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824";

export const ANDROID_PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.t3tools.t3code";

// Runs at build time, so each deploy picks up the current count.
async function fetchGithubStars(): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  try {
    const response = await fetch("https://api.github.com/repos/pingdotgg/t3code", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
    const { stargazers_count: stars } = (await response.json()) as { stargazers_count: number };
    return stars < 1000 ? String(stars) : `${Math.floor(stars / 1000)}k+`;
  } catch (error) {
    // A deploy must not ship a made-up count; offline dev should still render.
    if (import.meta.env.PROD) throw new Error("Could not fetch GitHub stars", { cause: error });
    console.warn("Could not fetch GitHub stars", error);
    return "?";
  }
}

export const MARKETING_STATS = {
  githubStars: await fetchGithubStars(),
  users: "500,000",
} as const;
