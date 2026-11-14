import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

/**
 * GitLab writes uploads into a merge request as project-relative `/uploads/<secret>/<name>` links,
 * and a private project serves them only to a signed-in request.
 */
const UPLOAD_PATH_PATTERN =
  /^\/(?:-\/project\/(\d+)|((?:[\w.-]+\/)*[\w.-]+))\/uploads\/([0-9a-f]{32})\/([^/]+)$/iu;
/** GitLab writes uploads into text as `/uploads/<secret>/<name>`, relative to the project. */
const PROJECT_RELATIVE_UPLOAD_PATTERN = /^\/uploads\/[0-9a-f]{32}\//iu;

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
    : {
        fetchUrl: `${upload.origin}${url.pathname}`,
        fileName: fileName(upload.fileSegment),
        // The secret is minted per upload, so a URL never names different bytes.
        immutable: true,
      };
}

export function isGitLabProjectRelativePath(path: string): boolean {
  return PROJECT_RELATIVE_UPLOAD_PATTERN.test(path);
}
