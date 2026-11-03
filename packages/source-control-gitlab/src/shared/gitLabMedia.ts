import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

/**
 * GitLab addresses a file uploaded to a description or comment by a random secret, and serves it
 * to the web route only to a signed-in browser session: a token sent there is redirected to the
 * sign-in page. The API route serves the same bytes to a token, with ranges, so that is the one
 * to fetch.
 */
const SECRET = "([0-9a-f]{32})";
const FILE = "([^/]+)";
/** `/group/sub/project/uploads/…`, the form a body's relative link resolves to. */
const PROJECT_PATH_UPLOAD = new RegExp(`^/((?:[^/]+/)+[^/]+)/uploads/${SECRET}/${FILE}$`, "u");
/** `/-/project/123/uploads/…`, the form newer GitLab writes. */
const PROJECT_ID_UPLOAD = new RegExp(`^/-/project/(\\d+)/uploads/${SECRET}/${FILE}$`, "u");
/** The `fetchUrl` this returns, which must read back as itself. */
const API_UPLOAD = new RegExp(`^/api/v4/projects/([^/]+)/uploads/${SECRET}/${FILE}$`, "u");

/** A relative upload link in a description or comment, which GitLab resolves against the project. */
const RELATIVE_UPLOAD_LINK =
  /(\]\(\s*<?|^\s{0,3}\[[^\]\n]+\]:\s*<?|\b(?:src|href)\s*=\s*["'])\/uploads\/(?=[0-9a-f]{32}\/)/gimu;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function fileName(segment: string): string {
  const name = decodeSegment(segment).replace(/[\p{Cc}\\/]/gu, "");
  return name.length > 0 ? name : "gitlab-upload";
}

function upload(origin: string, project: string, secret: string, file: string) {
  return {
    fetchUrl: `${origin}/api/v4/projects/${project}/uploads/${secret}/${file}`,
    fileName: fileName(file),
    // The secret names one file for good; replacing it uploads a new one.
    immutable: true,
  } satisfies SourceControlMediaUrl;
}

/** The hosts `recognizeRemote` reads as GitLab, the only ones a GitLab account can be signed in to. */
export function isGitLabHostname(hostname: string): boolean {
  return hostname === "gitlab.com" || hostname.split(".").includes("gitlab");
}

export function gitLabMediaUrl(url: URL): SourceControlMediaUrl | null {
  // A token is only ever sent over TLS.
  if (url.protocol !== "https:" || !isGitLabHostname(url.hostname.toLowerCase())) return null;
  const api = API_UPLOAD.exec(url.pathname);
  if (api) return upload(url.origin, api[1]!, api[2]!, api[3]!);
  const byId = PROJECT_ID_UPLOAD.exec(url.pathname);
  if (byId) return upload(url.origin, byId[1]!, byId[2]!, byId[3]!);
  const byPath = PROJECT_PATH_UPLOAD.exec(url.pathname);
  if (byPath === null) return null;
  const projectPath = byPath[1]!;
  // `/-/` starts a route below the project, so what comes before it is not a whole project path.
  if (projectPath.split("/").includes("-")) return null;
  return upload(url.origin, encodeURIComponent(decodeSegment(projectPath)), byPath[2]!, byPath[3]!);
}

/**
 * GitLab writes an upload into markdown as `/uploads/<secret>/<file>`, relative to the project.
 * Spelled out against `projectUrl`, a client can tell it from a workspace path and load it.
 */
export function absoluteGitLabUploadLinks(markdown: string, projectUrl: string): string {
  const base = projectUrl.replace(/\/+$/u, "");
  return markdown.replace(
    RELATIVE_UPLOAD_LINK,
    (_match, prefix: string) => `${prefix}${base}/uploads/`,
  );
}
