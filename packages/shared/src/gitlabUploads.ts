import { isGitLabUploadReference } from "@t3tools/contracts";

export interface GitLabUploadContext {
  readonly repositoryUrl: string;
  /** Login host can differ from GitLab's advertised repository URL. */
  readonly host?: string | undefined;
}

/** Resolves MR-relative uploads and copied project-ID links before workspace path handling. */
export function gitlabUploadSource(source: string, context: GitLabUploadContext) {
  try {
    const base = context.repositoryUrl.replace(/\/$/u, "");
    const url = new URL(
      /^\/?uploads\//u.test(source) ? `${base}/${source.replace(/^\//u, "")}` : source,
      `${base}/`,
    );
    if (url.username || url.password || url.search) return null;
    const match = /^\/(.+)\/uploads\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
    if (match === null) return null;
    const login = new URL(url.origin);
    if (context.host && url.origin === new URL(base).origin) login.host = context.host;
    const reference = {
      origin: login.origin,
      project: /(?:^|\/)-\/project\/(\d+)$/u.exec(match[1]!)?.[1] ?? decodeURIComponent(match[1]!),
      secret: match[2]!,
      fileName: decodeURIComponent(match[3]!),
    };
    return isGitLabUploadReference(reference) ? { reference, url: url.toString() } : null;
  } catch {
    return null;
  }
}
