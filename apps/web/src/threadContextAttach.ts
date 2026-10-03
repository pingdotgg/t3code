import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import {
  ThreadContextId,
  ThreadContextRecord as ThreadContextRecordSchema,
} from "@t3tools/contracts";
import { randomUUID } from "./lib/utils";
import { THREAD_CONTEXT_MAX_RECORDS } from "@t3tools/contracts";
import { matchThreadContextTitle, scopedThreadKey } from "@t3tools/client-runtime";
import {
  collectThreadContextReferences,
  formatThreadContextReference,
  replaceThreadContextReferences,
  sanitizeThreadContextLabel,
} from "@t3tools/shared/threadContext";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Candidates for the @thread-name picker.
// ---------------------------------------------------------------------------

export interface ThreadContextCandidate {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  title: string;
  projectId: string | null;
  projectName: string | null;
  archivedAt: string | null;
  updatedAt: string;
  createdAt: string;
  isDraft: boolean;
}

export interface ThreadContextCandidateView extends ThreadContextCandidate {
  displayLabel: string;
  disambiguation: string | null;
}

const THREAD_PICKER_LIMIT = 5;

function timestampOf(candidate: ThreadContextCandidate): string {
  return candidate.updatedAt || candidate.createdAt;
}

export function queryThreadContextCandidates(
  threads: ReadonlyArray<ThreadContextCandidate>,
  options: {
    query: string;
    environmentId: EnvironmentId;
    selfThreadId: ThreadId;
    limit?: number;
  },
): ThreadContextCandidateView[] {
  const query = options.query.trim().toLowerCase();
  // Bare @ must leave existing file results unchanged: no thread section.
  if (query.length === 0) return [];
  const limit = options.limit ?? THREAD_PICKER_LIMIT;
  const needle = query;
  const matches = threads.filter((thread) => {
    if (thread.environmentId !== options.environmentId) return false;
    if (thread.archivedAt !== null) return false;
    if (thread.isDraft) return false;
    if (thread.threadId === options.selfThreadId) return false;
    if (!thread.title || thread.title.trim().length === 0) return false;
    return matchThreadContextTitle(thread.title, needle);
  });
  matches.sort((left, right) => {
    const time = timestampOf(right).localeCompare(timestampOf(left));
    if (time !== 0) return time;
    return String(right.threadId).localeCompare(String(left.threadId));
  });
  const sliced = matches.slice(0, Math.max(0, Math.min(limit, THREAD_PICKER_LIMIT)));
  // Project disambiguates duplicate titles.
  const titleCounts = new Map<string, number>();
  for (const entry of sliced) {
    const key = entry.title.trim().toLowerCase();
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  return sliced.map((entry) => {
    const needsDisambiguation = (titleCounts.get(entry.title.trim().toLowerCase()) ?? 0) > 1;
    const disambiguation = needsDisambiguation
      ? (entry.projectName ?? entry.projectId ?? null)
      : null;
    return {
      ...entry,
      displayLabel:
        disambiguation != null && disambiguation.length > 0
          ? `${entry.title} — ${disambiguation}`
          : entry.title,
      disambiguation,
    };
  });
}

// ---------------------------------------------------------------------------
// Capability gating: the selected environment must explicitly advertise
// thread context. Unknown, missing, or false capabilities stay closed.
// ---------------------------------------------------------------------------

export interface ThreadContextCapabilities {
  threadContext?: boolean | undefined;
}

export function isThreadContextSupported(
  descriptor: { capabilities?: ThreadContextCapabilities | undefined } | null | undefined,
): boolean {
  return descriptor?.capabilities?.threadContext === true;
}

export function selectThreadContextDescriptor<
  T extends { environmentId: EnvironmentId; capabilities?: ThreadContextCapabilities },
>(input: {
  environmentId: EnvironmentId;
  primaryDescriptor: T | null;
  savedDescriptor: T | null;
}): T | null {
  if (input.primaryDescriptor?.environmentId === input.environmentId) {
    return input.primaryDescriptor;
  }
  return input.savedDescriptor?.environmentId === input.environmentId
    ? input.savedDescriptor
    : null;
}

// ---------------------------------------------------------------------------
// Identity: one generated grammar-safe contextId per scoped (environment,
// thread) record. Dedup keys are the scoped pair, never the thread id alone,
// so the same thread id on two environments never collides.
// ---------------------------------------------------------------------------

export function createThreadContextId(): ThreadContextId {
  return ThreadContextId.make(`thread-${randomUUID()}`);
}

function scopedKeyOf(ref: { environmentId: EnvironmentId; threadId: ThreadId }): string {
  return scopedThreadKey({ environmentId: ref.environmentId, threadId: ref.threadId });
}

export interface ThreadResolution {
  title: string;
}

export interface AttachThreadContextsInput {
  existingPrompt: string;
  existingRecords: ReadonlyArray<ThreadContextRecord>;
  refs: ReadonlyArray<ScopedThreadRef>;
  environmentId: EnvironmentId;
  selfThreadId: ThreadId;
  capabilities: ThreadContextCapabilities;
  resolveThread: (ref: ScopedThreadRef) => ThreadResolution | null;
  caret?: number | undefined;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
}

export interface AttachThreadContextsOutcome {
  ok: boolean;
  reason: string | null;
  prompt: string;
  records: ThreadContextRecord[];
  insertedIds: string[];
  cursor: number;
}

function caretOrEnd(prompt: string, caret: number | undefined): number {
  if (caret === undefined || !Number.isFinite(caret)) return prompt.length;
  return Math.max(0, Math.min(prompt.length, Math.floor(caret)));
}

function insertReferencesAtCaret(
  prompt: string,
  insertions: ReadonlyArray<string>,
  caret: number | undefined,
): { prompt: string; cursor: number } {
  const at = caretOrEnd(prompt, caret);
  const before = prompt.slice(0, at);
  const after = prompt.slice(at);
  const spacer = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const inserted = insertions.join("");
  return {
    prompt: `${before}${spacer}${inserted}${after}`,
    cursor: (before + spacer + inserted).length,
  };
}

function referencedContextIds(prompt: string): Set<string> {
  return new Set(
    collectThreadContextReferences(prompt).map((occurrence) => String(occurrence.contextId)),
  );
}

export function attachThreadContexts(
  input: AttachThreadContextsInput,
): AttachThreadContextsOutcome {
  const unchanged = {
    prompt: input.existingPrompt,
    records: [...input.existingRecords],
    insertedIds: [] as string[],
    cursor: caretOrEnd(input.existingPrompt, input.caret),
  };
  if (input.disabled === true || input.busy === true) {
    return {
      ...unchanged,
      ok: false,
      reason: "Composer is busy. Try again after the turn settles.",
    };
  }
  if (input.capabilities.threadContext !== true) {
    return {
      ...unchanged,
      ok: false,
      reason: "This server does not support thread context. Update the server to attach threads.",
    };
  }
  if (input.refs.length === 0) {
    return { ...unchanged, ok: false, reason: "No threads to attach." };
  }
  // Mixed-environment batches are rejected atomically: no partial mutation.
  for (const ref of input.refs) {
    if (ref.environmentId !== input.environmentId) {
      return {
        ...unchanged,
        ok: false,
        reason: "Threads must be on the same environment as this chat.",
      };
    }
  }
  for (const ref of input.refs) {
    if (ref.threadId === input.selfThreadId && ref.environmentId === input.environmentId) {
      return { ...unchanged, ok: false, reason: "Cannot attach the current thread to itself." };
    }
  }
  const recordsByScope = new Map<string, ThreadContextRecord>();
  for (const record of input.existingRecords) {
    recordsByScope.set(scopedKeyOf(record), record);
  }
  const freshRefs: ScopedThreadRef[] = [];
  const seenInBatch = new Set<string>();
  for (const ref of input.refs) {
    const key = scopedKeyOf(ref);
    if (recordsByScope.has(key) || seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    freshRefs.push(ref);
  }
  if (input.existingRecords.length + freshRefs.length > THREAD_CONTEXT_MAX_RECORDS) {
    return {
      ...unchanged,
      ok: false,
      reason: `Thread context is limited to ${THREAD_CONTEXT_MAX_RECORDS} threads.`,
    };
  }
  const nextRecords: ThreadContextRecord[] = [...input.existingRecords];
  const insertions: string[] = [];
  const insertedIds: string[] = [];
  for (const ref of freshRefs) {
    const resolved = input.resolveThread(ref);
    if (!resolved || !resolved.title || resolved.title.trim().length === 0) {
      // Dangling threads never mutate the draft.
      return { ...unchanged, ok: false, reason: "That thread no longer exists." };
    }
    const contextId = createThreadContextId();
    const label = sanitizeThreadContextLabel(resolved.title);
    nextRecords.push({
      version: 1,
      kind: "thread",
      contextId,
      label,
      environmentId: input.environmentId,
      threadId: ref.threadId,
      title: sanitizeThreadContextLabel(resolved.title),
    });
    insertions.push(`${formatThreadContextReference({ contextId, label })} `);
    insertedIds.push(String(ref.threadId));
  }
  // A batch can contain both new threads and retained records whose chip was deleted.
  const referenced = referencedContextIds(input.existingPrompt);
  const restored = new Set<ThreadContextId>();
  for (const ref of input.refs) {
    const record = recordsByScope.get(scopedKeyOf(ref));
    if (!record || referenced.has(record.contextId) || restored.has(record.contextId)) continue;
    const resolved = input.resolveThread(ref);
    if (!resolved?.title.trim()) {
      return { ...unchanged, ok: false, reason: "That thread no longer exists." };
    }
    restored.add(record.contextId);
    insertions.push(`${formatThreadContextReference(record)} `);
    insertedIds.push(record.threadId);
  }
  if (insertions.length === 0) return { ...unchanged, ok: true, reason: null };
  const inserted = insertReferencesAtCaret(input.existingPrompt, insertions, input.caret);
  return {
    ok: true,
    reason: null,
    prompt: inserted.prompt,
    records: nextRecords,
    insertedIds,
    cursor: inserted.cursor,
  };
}

// ---------------------------------------------------------------------------
// Structured clipboard. Copy/cut carry the selected text plus the referenced
// records on a private MIME type (with an HTML rendering for external
// targets); paste validates the payload against the shared record schema and
// merges it at the caret, retaining unrelated draft content.
// ---------------------------------------------------------------------------

export const THREAD_CONTEXT_CLIPBOARD_MIME = "application/x-t3-thread-context" as const;

export interface ThreadContextClipboardPayload {
  version: 1;
  records: ThreadContextRecord[];
}

export interface SerializedThreadContextClipboard {
  mimeType: typeof THREAD_CONTEXT_CLIPBOARD_MIME;
  json: string;
  html: string;
  text: string;
}

function escapeClipboardHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function serializeThreadContextClipboard(
  prompt: string,
  records: ReadonlyArray<ThreadContextRecord>,
): SerializedThreadContextClipboard {
  const payload: ThreadContextClipboardPayload = { version: 1, records: [...records] };
  const chips = records
    .map(
      (record) =>
        `<span data-t3-thread-context="${escapeClipboardHtml(String(record.contextId))}">#${escapeClipboardHtml(record.title || record.label)}</span>`,
    )
    .join(" ");
  return {
    mimeType: THREAD_CONTEXT_CLIPBOARD_MIME,
    json: JSON.stringify(payload),
    html: `<meta charset="utf-8"><div>${escapeClipboardHtml(prompt)}${chips.length > 0 ? ` ${chips}` : ""}</div>`,
    text: prompt,
  };
}

const isThreadContextRecord = Schema.is(ThreadContextRecordSchema);

export function parseThreadContextClipboardPayload(json: string): ThreadContextRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as { version?: unknown; records?: unknown };
  if (payload.version !== 1 || !Array.isArray(payload.records)) return null;
  if (payload.records.length > THREAD_CONTEXT_MAX_RECORDS) return null;
  const records: ThreadContextRecord[] = [];
  const seenIds = new Set<string>();
  for (const entry of payload.records) {
    if (!isThreadContextRecord(entry)) return null;
    const id = String(entry.contextId);
    if (seenIds.has(id)) return null;
    seenIds.add(id);
    records.push(entry);
  }
  return records;
}

/** Records referenced by the prompt slice in [start, end), in first-reference order. */
export function selectedThreadContextRecords(input: {
  prompt: string;
  records: ReadonlyArray<ThreadContextRecord>;
  start: number;
  end: number;
}): ThreadContextRecord[] {
  const from = Math.max(0, Math.min(input.prompt.length, Math.floor(input.start)));
  const to = Math.max(from, Math.min(input.prompt.length, Math.floor(input.end)));
  const byId = new Map(input.records.map((record) => [String(record.contextId), record]));
  const selected: ThreadContextRecord[] = [];
  const seen = new Set<string>();
  for (const occurrence of collectThreadContextReferences(input.prompt)) {
    if (occurrence.start < from || occurrence.end > to) continue;
    const key = String(occurrence.contextId);
    if (seen.has(key)) continue;
    seen.add(key);
    const record = byId.get(key);
    if (record) selected.push(record);
  }
  return selected;
}

export interface MergeThreadContextClipboardInput {
  pastedText: string;
  pastedRecords: ReadonlyArray<ThreadContextRecord>;
  existingPrompt: string;
  existingRecords: ReadonlyArray<ThreadContextRecord>;
  caret?: number | undefined;
  environmentId: EnvironmentId;
  selfThreadId: ThreadId;
  capabilities: ThreadContextCapabilities;
  resolveThread: (ref: ScopedThreadRef) => ThreadResolution | null;
}

export function mergeThreadContextClipboard(
  input: MergeThreadContextClipboardInput,
): AttachThreadContextsOutcome {
  const unchanged: AttachThreadContextsOutcome = {
    ok: false,
    reason: null,
    prompt: input.existingPrompt,
    records: [...input.existingRecords],
    insertedIds: [],
    cursor: caretOrEnd(input.existingPrompt, input.caret),
  };
  if (input.capabilities.threadContext !== true) {
    return {
      ...unchanged,
      reason: "This server does not support thread context. Update the server to attach threads.",
    };
  }
  const occurrences = collectThreadContextReferences(input.pastedText);
  const byId = new Map(input.pastedRecords.map((record) => [String(record.contextId), record]));
  const accepted: ThreadContextRecord[] = [];
  const recordsByScope = new Map(
    input.existingRecords.map((record) => [scopedKeyOf(record), record]),
  );
  const recordIds = new Set(input.existingRecords.map((record) => record.contextId));
  const rewritten = new Map<ThreadContextId, ThreadContextRecord>();
  const seenIds = new Set<string>();
  for (const occurrence of occurrences) {
    const key = String(occurrence.contextId);
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    const record = byId.get(key);
    if (!record) {
      return {
        ...unchanged,
        reason: "Pasted thread context is no longer available.",
      };
    }
    if (!isThreadContextRecord(record)) {
      return {
        ...unchanged,
        reason: "Pasted thread context is no longer available.",
      };
    }
    if (record.environmentId !== input.environmentId) {
      return {
        ...unchanged,
        reason: "Pasted threads must be on the same environment as this chat.",
      };
    }
    if (record.threadId === input.selfThreadId) {
      return { ...unchanged, reason: "Cannot attach the current thread to itself." };
    }
    const resolved = input.resolveThread({
      environmentId: record.environmentId,
      threadId: record.threadId,
    });
    if (!resolved || !resolved.title || resolved.title.trim().length === 0) {
      return { ...unchanged, reason: "That thread no longer exists." };
    }
    const scopeKey = scopedKeyOf(record);
    const existing = recordsByScope.get(scopeKey);
    if (existing) {
      rewritten.set(record.contextId, existing);
      continue;
    }
    const imported = recordIds.has(record.contextId)
      ? { ...record, contextId: createThreadContextId() }
      : record;
    recordIds.add(imported.contextId);
    recordsByScope.set(scopeKey, imported);
    rewritten.set(record.contextId, imported);
    accepted.push(imported);
  }
  if (input.existingRecords.length + accepted.length > THREAD_CONTEXT_MAX_RECORDS) {
    return {
      ...unchanged,
      reason: `Thread context is limited to ${THREAD_CONTEXT_MAX_RECORDS} threads.`,
    };
  }
  // The pasted text lands at the caret; unrelated draft content is retained.
  const at = caretOrEnd(input.existingPrompt, input.caret);
  const before = input.existingPrompt.slice(0, at);
  const after = input.existingPrompt.slice(at);
  const text = replaceThreadContextReferences(input.pastedText, (occurrence) => {
    const record = rewritten.get(occurrence.contextId);
    return record ? formatThreadContextReference(record) : occurrence.source;
  });
  const spacer = before.length > 0 && !/\s$/.test(before) && text.length > 0 ? " " : "";
  const nextPrompt = `${before}${spacer}${text}${after}`;
  return {
    ok: true,
    reason: null,
    prompt: nextPrompt,
    records: [...input.existingRecords, ...accepted],
    insertedIds: accepted.map((record) => String(record.threadId)),
    cursor: (before + spacer + text).length,
  };
}

export function removeThreadContextReference(
  prompt: string,
  contextId: string,
): { prompt: string; removed: boolean } {
  let removed = false;
  let result = "";
  let cursor = 0;
  for (const occurrence of collectThreadContextReferences(prompt)) {
    if (String(occurrence.contextId) === contextId) {
      result += prompt.slice(cursor, occurrence.start);
      cursor = occurrence.end;
      // Swallow one trailing space left by insertion.
      if (prompt[cursor] === " ") cursor += 1;
      removed = true;
    }
  }
  result += prompt.slice(cursor);
  return { prompt: result, removed };
}
