import type { ComposerContextId, FigmaContextRecord, JiraContextRecord } from "@t3tools/contracts";

import {
  formatComposerContextReference,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "./composerContextReferences.ts";

const JIRA_URL = /https?:\/\/([a-z0-9-]+\.)?atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)\b/giu;
const FIGMA_URL =
  /https?:\/\/(?:www\.)?figma\.com\/(file|design)\/([A-Za-z0-9]+)(?:\/([^?\s#]*))?(?:\?[^\s#]*)?(?:#([^?\s]*))?/giu;

export function parseJiraBrowseUrl(value: string): {
  readonly key: string;
  readonly url: string;
} | null {
  const match = /https?:\/\/([a-z0-9-]+\.)?atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)\b/iu.exec(
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
    /https?:\/\/(?:www\.)?figma\.com\/(file|design)\/([A-Za-z0-9]+)(?:\/([^?\s#]*))?(?:\?([^#\s]*))?(?:#([^\s]*))?/iu.exec(
      value.trim(),
    );
  if (!match) return null;
  const fileKey = match[2]!;
  let slug: string;
  try {
    slug = decodeURIComponent((match[3] ?? "").replace(/-/g, " ")).trim();
  } catch {
    return null;
  }
  const query = match[4] ?? "";
  const nodeFromQuery = /(?:^|&)node-id=([^&]+)/iu.exec(query)?.[1];
  let nodeId: string | undefined;
  if (nodeFromQuery) {
    try {
      nodeId = decodeURIComponent(nodeFromQuery.replace(/-/g, ":"));
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

export function jiraContextRecord(input: {
  readonly key: string;
  readonly url: string;
  readonly summary?: string;
}): JiraContextRecord {
  const summary = (input.summary ?? input.key).slice(0, 2_048);
  return {
    version: 1,
    kind: "jira",
    contextId: toKindScopedComposerContextId("jira", input.key),
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

/**
 * Turns pasted Jira/Figma browse URLs into context chip references. Returns the
 * rewritten text and the records to attach; unchanged text when nothing matched.
 */
export function externalLinkContextReferences(
  text: string,
  accept: (record: JiraContextRecord | FigmaContextRecord) => ComposerContextId | undefined = (
    record,
  ) => record.contextId,
): {
  readonly text: string;
  readonly records: ReadonlyArray<JiraContextRecord | FigmaContextRecord>;
} {
  const records = new Map<ComposerContextId, JiraContextRecord | FigmaContextRecord>();
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
    const parsed = parseFigmaDesignUrl(match);
    if (!parsed) return match;
    const record = figmaContextRecord(parsed);
    const contextId = accept(record);
    if (contextId === undefined) return match;
    records.set(record.contextId, record);
    return formatComposerContextReference({ ...record, contextId });
  });

  return { text: rewritten, records: [...records.values()] };
}
