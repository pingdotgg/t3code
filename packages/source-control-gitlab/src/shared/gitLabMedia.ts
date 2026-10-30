import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

/**
 * GitLab writes uploads into a merge request as project-relative `/uploads/<secret>/<name>` links,
 * and a private project serves them only to a signed-in request.
 */
const UPLOAD_PATH_PATTERN =
  /^\/(?:-\/project\/(\d+)|((?:[\w.-]+\/)*[\w.-]+))\/uploads\/([0-9a-f]{32})\/([^/]+)$/iu;
/**
 * An inline code span, kept as written, or a link destination, HTML `src`/`href`, or reference
 * definition pointing at an upload.
 */
const RELATIVE_UPLOAD_PATTERN =
  /(`+)[^`]*?\1|(\]\(\s*<?|\b(?:src|href)\s*=\s*["']?|^ {0,3}\[[^\]\n]+\]:\s*<?)\/uploads\/(?=[0-9a-f]{32}\/)/giu;
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})(.*)$/u;
/** A reference definition may put its destination on the next line. */
const BARE_REFERENCE_LABEL_PATTERN = /^ {0,3}\[[^\]\n]+\]:\s*$/u;
const CONTINUED_UPLOAD_PATTERN = /^(\s*<?)\/uploads\/(?=[0-9a-f]{32}\/)/u;

export interface GitLabUpload {
  readonly origin: string;
  /** A numeric project id or the full project path, as the API's `:id` accepts either. */
  readonly project: string;
  readonly secret: string;
  /** The file name segment, still percent-encoded. */
  readonly fileSegment: string;
}

export function parseGitLabUpload(url: URL): GitLabUpload | null {
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const match = UPLOAD_PATH_PATTERN.exec(url.pathname);
  if (match === null) return null;
  const [, projectId, projectPath, secret, fileSegment] = match;
  // `-` separates a project path from its routes, so it is never part of one.
  if (projectPath?.split("/").includes("-")) return null;
  return {
    origin: url.origin,
    project: projectId ?? projectPath!,
    secret: secret!,
    fileSegment: fileSegment!,
  };
}

/** The API route that serves the upload to any project member (GitLab 17.4+). */
export function gitLabUploadApiUrl(upload: GitLabUpload): string {
  return `${upload.origin}/api/v4/projects/${encodeURIComponent(upload.project)}/uploads/${upload.secret}/${upload.fileSegment}`;
}

function fileName(fileSegment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(fileSegment);
  } catch {
    decoded = fileSegment;
  }
  const name = decoded.replace(/[\p{Cc}\\/]/gu, "");
  return name.length > 0 ? name : "gitlab-upload";
}

export function gitLabMediaUrl(url: URL): SourceControlMediaUrl | null {
  const upload = parseGitLabUpload(url);
  return upload === null
    ? null
    : { fetchUrl: `${upload.origin}${url.pathname}`, fileName: fileName(upload.fileSegment) };
}

/** Rewrites GitLab's project-relative upload links against the project's web URL, outside code. */
export function resolveGitLabUploadLinks(markdown: string, projectUrl: string): string {
  const base = projectUrl.replace(/\/+$/u, "");
  let openFence: string | null = null;
  let afterBareLabel = false;
  return markdown
    .split("\n")
    .map((line) => {
      const continuesLabel = afterBareLabel;
      afterBareLabel = false;
      const fence = FENCE_PATTERN.exec(line.replace(/\r$/u, ""));
      if (fence !== null) {
        const marker = fence[1]!;
        if (openFence === null) openFence = marker;
        else if (
          marker[0] === openFence[0] &&
          marker.length >= openFence.length &&
          fence[2]!.trim() === ""
        ) {
          openFence = null;
        }
        return line;
      }
      if (openFence !== null) return line;
      if (continuesLabel) {
        line = line.replace(CONTINUED_UPLOAD_PATTERN, (_match, prefix: string) => {
          return `${prefix}${base}/uploads/`;
        });
      }
      afterBareLabel = BARE_REFERENCE_LABEL_PATTERN.test(line);
      return line.replace(RELATIVE_UPLOAD_PATTERN, (match, _code, prefix: string | undefined) =>
        prefix === undefined ? match : `${prefix}${base}/uploads/`,
      );
    })
    .join("\n");
}
