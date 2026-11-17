import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

/** Gitea serves a repository file's bytes below `raw`, and an LFS pointer's below `media`. */
const FILE_ROUTES = new Set(["raw", "media"]);
/**
 * The ref keyword Gitea's own file links carry. The bare `raw/<ref>/<path>` shorthand is left
 * unclaimed: any file server can spell a path that way, and a wrong claim routes a public image
 * through this host's credential.
 */
const REF_KEYWORDS = new Set(["branch", "tag", "commit"]);
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

function fileName(fetchUrl: string): string {
  const segment = new URL(fetchUrl).pathname.split("/").pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const name = decoded.replace(/[\p{Cc}\\/]/gu, "");
  return name.length > 0 ? name : "forgejo-media";
}

/**
 * A repository file on a Forgejo or Gitea server, whose bytes a token decides the answer to.
 * Owners may nest, so the route is found rather than counted from the start.
 */
export function forgejoMediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const route = segments.findIndex(
    (segment, index) => index >= 2 && FILE_ROUTES.has(segment.toLowerCase()),
  );
  if (route < 2) return null;
  const keyword = segments[route + 1]?.toLowerCase();
  const ref = segments[route + 2];
  if (keyword === undefined || !REF_KEYWORDS.has(keyword) || ref === undefined) return null;
  if (segments.length <= route + 3) return null;
  const fetchUrl = new URL(url);
  fetchUrl.hash = "";
  return {
    fetchUrl: fetchUrl.toString(),
    fileName: fileName(fetchUrl.toString()),
    ...(keyword === "commit" && COMMIT_SHA_PATTERN.test(ref) ? { immutable: true as const } : {}),
  };
}
