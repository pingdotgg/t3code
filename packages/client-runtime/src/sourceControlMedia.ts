import {
  isSourceControlMediaReference,
  type SourceControlMediaReference,
} from "@t3tools/contracts";

export interface MarkdownImageContext {
  readonly provider: string;
  readonly repositoryUrl: string;
  /** Host used to access the MR; GitLab may advertise a different canonical hostname. */
  readonly host?: string | undefined;
}

/** Resolves GitLab's repository-relative uploads and preserves project IDs on copied links. */
export function sourceControlMediaSource(
  source: string,
  context?: MarkdownImageContext | null,
): {
  readonly _tag: "SourceControlMedia";
  readonly reference: SourceControlMediaReference;
  readonly uri: string;
} | null {
  const github = { _tag: "github", url: source } as const;
  if (isSourceControlMediaReference(github)) {
    return { _tag: "SourceControlMedia", reference: github, uri: source };
  }
  try {
    const base = context?.provider === "gitlab" ? context.repositoryUrl.replace(/\/$/, "") : null;
    const url = new URL(
      base !== null && /^\/?uploads\//u.test(source)
        ? `${base}/${source.replace(/^\//u, "")}`
        : source,
      base ?? undefined,
    );
    if (url.username || url.password || url.search || url.hash) return null;
    const match = /^\/(.+)\/uploads\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
    if (match === null) return null;
    const loginUrl = new URL(url.origin);
    if (context?.host && base !== null && url.origin === new URL(base).origin) {
      loginUrl.host = context.host;
    }
    const reference = {
      _tag: "gitlab",
      origin: loginUrl.origin,
      project: /(?:^|\/)-\/project\/(\d+)$/u.exec(match[1]!)?.[1] ?? decodeURIComponent(match[1]!),
      secret: match[2]!,
      fileName: decodeURIComponent(match[3]!),
    } as const;
    return isSourceControlMediaReference(reference)
      ? { _tag: "SourceControlMedia", reference, uri: url.toString() }
      : null;
  } catch {
    return null;
  }
}
