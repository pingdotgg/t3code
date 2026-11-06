function trimTrailingProsePunctuation(value: string): string {
  return value.replace(/[.,;:!)]+$/u, "");
}

/** True when `url` is safe to place inside a markdown link href. */
export function isSafeComposerContextMarkdownHref(url: string): boolean {
  const trimmed = url.trim();
  return trimmed.length > 0 && !/[\s)]/.test(trimmed);
}

export function parseJiraBrowseUrl(value: string): {
  readonly key: string;
  readonly url: string;
} | null {
  const match = /^https?:\/\/([a-z0-9-]+\.)?atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)\b/iu.exec(
    value.trim(),
  );
  if (!match) return null;
  return { key: match[2]!, url: match[0]! };
}

export function parseFigmaDesignUrl(value: string): {
  readonly fileKey: string;
  readonly url: string;
  readonly name: string;
  readonly nodeId?: string;
} | null {
  const match =
    /^https?:\/\/(?:www\.)?figma\.com\/(file|design)\/([A-Za-z0-9]+)(?:\/([^\s?#]*))?(?:\?([^\s#]*))?(?:#([^\s]*))?/iu.exec(
      trimTrailingProsePunctuation(value.trim()),
    );
  if (!match) return null;
  const fileKey = match[2]!;
  let slug: string;
  try {
    slug = decodeURIComponent(
      trimTrailingProsePunctuation(match[3] ?? "").replace(/-/g, " "),
    ).trim();
  } catch {
    return null;
  }
  const query = trimTrailingProsePunctuation(match[4] ?? "");
  const nodeFromQuery = /(?:^|&)node-id=([^&]+)/iu.exec(query)?.[1];
  let nodeId: string | undefined;
  if (nodeFromQuery) {
    try {
      nodeId = decodeURIComponent(trimTrailingProsePunctuation(nodeFromQuery).replace(/-/g, ":"));
    } catch {
      return null;
    }
  }
  const url = `https://www.figma.com/design/${fileKey}${nodeId ? `?node-id=${encodeURIComponent(nodeId)}` : ""}`;
  return {
    fileKey,
    url,
    name: slug || fileKey,
    ...(nodeId !== undefined ? { nodeId } : {}),
  };
}

export function parseGitHubIssueUrl(value: string): {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly repository: string;
  readonly state: "open" | "closed";
} | null {
  const match = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\b/iu.exec(value.trim());
  if (!match) return null;
  const host = match[1]!.toLowerCase();
  // Avoid turning Jira/Atlassian or Figma hosts into fake GitHub issues.
  if (host.includes("atlassian.net") || host.includes("figma.com")) return null;
  const owner = match[2]!;
  const name = match[3]!;
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const repository = `${owner}/${name}`;
  return {
    number,
    title: `#${number}`,
    url: `https://${match[1]}/${repository}/issues/${number}`,
    repository,
    state: "open",
  };
}

/** GitHub-like `https://host/owner/repo/pull/N` URLs, canonicalized without trailing slash. */
export function parseGitHubPullRequestUrl(value: string): {
  readonly number: number;
  readonly url: string;
  readonly repository: string;
} | null {
  const match = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?/iu.exec(value.trim());
  if (!match) return null;
  const host = match[1]!.toLowerCase();
  if (host.includes("atlassian.net") || host.includes("figma.com")) return null;
  const owner = match[2]!;
  const name = match[3]!;
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const repository = `${owner}/${name}`;
  return {
    number,
    url: `https://${match[1]}/${repository}/pull/${number}`,
    repository,
  };
}
