import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";
import { guessThreadLinkRef, replaceThreadLinks, threadLinkCandidates } from "./threadLinks.ts";

/** Resolves links in the same order as the UI; reuse across a batch of messages. */
export function createMentionedThreadResolver(
  messageEnvironmentId: EnvironmentId,
  knownThreads: ReadonlyArray<ScopedThreadRef>,
): (markdown: string) => ReadonlyArray<ScopedThreadRef> {
  const keys = new Set(
    knownThreads.map((ref) => JSON.stringify([ref.environmentId, ref.threadId])),
  );
  return (markdown) => {
    const found = new Map<string, ScopedThreadRef>();
    replaceThreadLinks(markdown, (link) => {
      const ref =
        threadLinkCandidates(link, messageEnvironmentId).find((candidate) =>
          keys.has(JSON.stringify([candidate.environmentId, candidate.threadId])),
        ) ?? guessThreadLinkRef(link, knownThreads);
      if (ref) found.set(JSON.stringify([ref.environmentId, ref.threadId]), ref);
      return undefined;
    });
    return [...found.values()];
  };
}

export function mentionedThreadRefs(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
  knownThreads: ReadonlyArray<ScopedThreadRef>,
): ReadonlyArray<ScopedThreadRef> {
  return createMentionedThreadResolver(messageEnvironmentId, knownThreads)(markdown);
}

/** Direct thread waits in a live run; other tools and ended calls do not imply a wait. */
export function directThreadWaits(input: {
  readonly environmentId: EnvironmentId;
  readonly activeRunId: string | null;
  readonly items: ReadonlyArray<{
    readonly runId: string | null;
    readonly type: string;
    readonly status: string;
    readonly toolName?: string | null | undefined;
    readonly input?: unknown;
  }>;
}): ReadonlyArray<ScopedThreadRef> {
  if (input.activeRunId === null) return [];
  const refs = new Map<string, ScopedThreadRef>();
  for (const item of input.items) {
    if (
      item.runId !== input.activeRunId ||
      item.type !== "dynamic_tool" ||
      (item.status !== "running" && item.status !== "waiting") ||
      resolveT3McpToolId(item.toolName ?? null) !== "t3_thread_wait" ||
      typeof item.input !== "object" ||
      item.input === null
    )
      continue;
    const value = item.input as Record<string, unknown>;
    if (typeof value.threadId !== "string" || !value.threadId.trim()) continue;
    if (
      value.environmentId !== undefined &&
      (typeof value.environmentId !== "string" || !value.environmentId.trim())
    )
      continue;
    const ref = {
      environmentId:
        typeof value.environmentId === "string"
          ? EnvironmentId.make(value.environmentId)
          : input.environmentId,
      threadId: ThreadId.make(value.threadId),
    };
    refs.set(JSON.stringify([ref.environmentId, ref.threadId]), ref);
  }
  return [...refs.values()];
}
