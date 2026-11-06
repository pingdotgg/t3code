import type {
  ComposerContextId,
  FigmaContextRecord,
  IssueContextRecord,
  JiraContextRecord,
} from "@t3tools/contracts";

import {
  formatComposerContextReference,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "./composerContextReferences.ts";
import {
  parseFigmaDesignUrl,
  parseGitHubIssueUrl,
  parseJiraBrowseUrl,
} from "./composerContextExternalUrls.ts";

export {
  parseFigmaDesignUrl,
  parseGitHubIssueUrl,
  parseGitHubPullRequestUrl,
  parseJiraBrowseUrl,
} from "./composerContextExternalUrls.ts";

const JIRA_URL = /https?:\/\/([a-z0-9-]+\.)?atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)\b/giu;
/** Allow `.` in path/query/hash; trim trailing prose punctuation after the match. */
const FIGMA_URL =
  /https?:\/\/(?:www\.)?figma\.com\/(file|design)\/([A-Za-z0-9]+)(?:\/([^\s?#]*))?(?:\?([^\s#]*))?(?:#([^\s]*))?/giu;
const GITHUB_ISSUE_URL = /https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\b/giu;

function trimTrailingProsePunctuation(value: string): string {
  return value.replace(/[.,;:!)]+$/u, "");
}

type ExternalLinkContextRecord = JiraContextRecord | FigmaContextRecord | IssueContextRecord;

export function jiraContextRecord(input: {
  readonly key: string;
  readonly url: string;
  readonly summary?: string;
}): JiraContextRecord {
  const summary = (input.summary ?? input.key).slice(0, 2_048);
  let host = "atlassian.net";
  try {
    host = new URL(input.url).host.toLowerCase() || host;
  } catch {
    // Keep a stable fallback when the URL is malformed.
  }
  return {
    version: 1,
    kind: "jira",
    contextId: toKindScopedComposerContextId("jira", `${host}:${input.key}`),
    label: sanitizeComposerContextLabel(input.key, "jira"),
    key: input.key,
    url: input.url.slice(0, 2_048),
    summary,
  };
}

export function figmaContextRecord(input: {
  readonly fileKey: string;
  readonly url: string;
  readonly name: string;
  readonly nodeId?: string;
}): FigmaContextRecord {
  return {
    version: 1,
    kind: "figma",
    contextId: toKindScopedComposerContextId(
      "figma",
      input.nodeId === undefined ? input.fileKey : `${input.fileKey}:${input.nodeId}`,
    ),
    label: sanitizeComposerContextLabel(input.name || input.fileKey, "figma"),
    fileKey: input.fileKey,
    url: input.url.slice(0, 2_048),
    name: input.name.slice(0, 2_048),
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
  };
}

export function issueContextRecord(input: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly repository: string;
  readonly state: "open" | "closed";
}): IssueContextRecord {
  let host = "github.com";
  try {
    host = new URL(input.url).host.toLowerCase() || host;
  } catch {
    // Keep a stable fallback when the URL is malformed.
  }
  return {
    version: 1,
    kind: "issue",
    contextId: toKindScopedComposerContextId(
      "issue",
      `${host}:${input.repository.toLowerCase()}#${input.number}`,
    ),
    label: sanitizeComposerContextLabel(`#${input.number}`, "issue"),
    number: input.number,
    title: input.title.slice(0, 2_048),
    url: input.url.slice(0, 2_048),
    repository: input.repository.slice(0, 256),
    state: input.state,
  };
}

/**
 * Turns pasted Jira/Figma/GitHub-issue browse URLs into context chip references. Returns the
 * rewritten text and the records to attach; unchanged text when nothing matched.
 */
export function externalLinkContextReferences(
  text: string,
  accept: (record: ExternalLinkContextRecord) => ComposerContextId | undefined = (record) =>
    record.contextId,
): {
  readonly text: string;
  readonly records: ReadonlyArray<ExternalLinkContextRecord>;
} {
  const records = new Map<ComposerContextId, ExternalLinkContextRecord>();
  let rewritten = text;

  rewritten = rewritten.replace(JIRA_URL, (match) => {
    const parsed = parseJiraBrowseUrl(match);
    if (!parsed) return match;
    const record = jiraContextRecord(parsed);
    const contextId = accept(record);
    if (contextId === undefined) return match;
    records.set(record.contextId, record);
    return formatComposerContextReference({ ...record, contextId });
  });

  rewritten = rewritten.replace(FIGMA_URL, (match) => {
    const trimmed = trimTrailingProsePunctuation(match);
    const trailing = match.slice(trimmed.length);
    const parsed = parseFigmaDesignUrl(trimmed);
    if (!parsed) return match;
    const record = figmaContextRecord(parsed);
    const contextId = accept(record);
    if (contextId === undefined) return match;
    records.set(record.contextId, record);
    return `${formatComposerContextReference({ ...record, contextId })}${trailing}`;
  });

  rewritten = rewritten.replace(GITHUB_ISSUE_URL, (match) => {
    const parsed = parseGitHubIssueUrl(match);
    if (!parsed) return match;
    const record = issueContextRecord(parsed);
    const contextId = accept(record);
    if (contextId === undefined) return match;
    records.set(record.contextId, record);
    return formatComposerContextReference({ ...record, contextId });
  });

  return { text: rewritten, records: [...records.values()] };
}
