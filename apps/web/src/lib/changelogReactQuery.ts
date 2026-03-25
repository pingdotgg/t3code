import { queryOptions } from "@tanstack/react-query";
import { GITHUB_REPO_SLUG } from "~/branding";

export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  /** `null` for draft releases (not returned by the public endpoint, but defensive). */
  published_at: string | null;
  html_url: string;
}

export const changelogQueryKeys = {
  releases: () => ["changelog", "releases"] as const,
};

export function changelogQueryOptions() {
  return queryOptions({
    queryKey: changelogQueryKeys.releases(),
    queryFn: async (): Promise<GitHubRelease[]> => {
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases?per_page=20`,
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (!response.ok) {
        const message =
          response.status === 403
            ? "GitHub API rate limit exceeded. Try again later."
            : `Failed to fetch releases (${response.status})`;
        throw new Error(message);
      }
      return response.json() as Promise<GitHubRelease[]>;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
