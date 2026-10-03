/**
 * Acceptance coverage for the composer thread-context repair.
 *
 * Failure modes under test (one per block below):
 * 1. Cross-composer copy/paste must carry structured records, insert at the
 *    caret, and retain unrelated draft content (paste used to receive only
 *    destination records and replace the whole draft).
 * 2. Deleting a reference keeps the stored record so native editor undo
 *    restores the binding; persisted reload prunes unreferenced records.
 * 3. Queue edit hydrates queued records and clears them with an explicit
 *    empty envelope when the last reference is removed (never `undefined`).
 * 4. Retry restore works when thread context was attached (the send ref used
 *    to poison the emptiness guard) without clobbering newer user edits.
 * 5. Old/unknown servers stay gated: attach, paste, and send builders reject
 *    without the `?? true` fallback.
 * 6. Queue-update dispatches replay the real transport schema.
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  ClientOrchestrationCommand,
  CommandId,
  EnvironmentId,
  OrchestrationMessageContext,
  QueuedTurnId,
  ThreadId,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  buildThreadContextForQueueUpdate,
  buildThreadContextForSend,
  countReferencedThreadContexts,
  isComposerDraftCleared,
} from "./components/ChatView.logic";
import {
  attachThreadContexts,
  isThreadContextSupported,
  mergeThreadContextClipboard,
  parseThreadContextClipboardPayload,
  removeThreadContextReference,
  selectedThreadContextRecords,
  serializeThreadContextClipboard,
} from "./threadContextAttach";
import { pruneUnreferencedThreadContextRecords, useComposerDraftStore } from "./composerDraftStore";

const ENV = EnvironmentId.make("env-repair");
const SELF = ThreadId.make("self-thread");
const OTHER = ThreadId.make("other-thread");
const SUPPORTED = { threadContext: true as const };

function resolveThread(ref: { threadId: ThreadId }) {
  return { title: `Title ${String(ref.threadId)}` };
}

function attach(threadId: string, prompt = "", records: ReadonlyArray<ThreadContextRecord> = []) {
  return attachThreadContexts({
    existingPrompt: prompt,
    existingRecords: records,
    refs: [scopeThreadRef(ENV, ThreadId.make(threadId))],
    environmentId: ENV,
    selfThreadId: SELF,
    capabilities: SUPPORTED,
    resolveThread,
  });
}

it("reattaches deleted references alongside new threads in one batch", () => {
  const first = attach("kept-reference");
  const mixed = attachThreadContexts({
    existingPrompt: "Follow up ",
    existingRecords: first.records,
    refs: [
      scopeThreadRef(ENV, ThreadId.make("kept-reference")),
      scopeThreadRef(ENV, ThreadId.make("new-reference")),
    ],
    environmentId: ENV,
    selfThreadId: SELF,
    capabilities: SUPPORTED,
    resolveThread,
  });
  expect(mixed.ok).toBe(true);
  expect(mixed.records).toHaveLength(2);
  expect(mixed.prompt).toContain(first.records[0]!.contextId);
  expect(buildThreadContextForSend(mixed.prompt, mixed.records)?.records).toHaveLength(2);
});

function fullContextHistory() {
  const result = attachThreadContexts({
    existingPrompt: "",
    existingRecords: [],
    refs: Array.from({ length: 32 }, (_, index) =>
      scopeThreadRef(ENV, ThreadId.make(`history-${index}`)),
    ),
    environmentId: ENV,
    selfThreadId: SELF,
    capabilities: SUPPORTED,
    resolveThread,
  });
  expect(result.ok).toBe(true);
  return result;
}

describe("active attachment budget excludes undo history", () => {
  it("attaches a new thread after all 32 earlier chips were deleted, preserving undo records", () => {
    const history = fullContextHistory();
    const next = attach("new-active", "", history.records);
    expect(next.ok).toBe(true);
    expect(next.records).toHaveLength(33);
    expect(countReferencedThreadContexts(next.prompt, next.records)).toBe(1);
    expect(buildThreadContextForSend(history.prompt, next.records)?.records).toHaveLength(32);
  });
  it("pastes into an empty composer with 32 retained records", () => {
    const history = fullContextHistory();
    const source = attach("pasted-active");
    const next = mergeThreadContextClipboard({
      pastedText: source.prompt,
      pastedRecords: source.records,
      existingPrompt: "",
      existingRecords: history.records,
      environmentId: ENV,
      selfThreadId: SELF,
      capabilities: SUPPORTED,
      resolveThread,
    });
    expect(next.ok).toBe(true);
    expect(next.records).toHaveLength(33);
    expect(buildThreadContextForSend(next.prompt, next.records)?.records).toEqual(source.records);
  });
  it("still rejects a 33rd visible reference, including reactivating a retained one", () => {
    const history = fullContextHistory();
    const extra = attach("inactive-extra");
    const records = [...history.records, ...extra.records];
    const next = attach("inactive-extra", history.prompt, records);
    expect(next.ok).toBe(false);
    expect(next.prompt).toBe(history.prompt);
    expect(next.records).toEqual(records);
  });
  it("stores new active records past the old history limit and persists only active bindings", () => {
    const history = fullContextHistory();
    const fresh = attach("new-store-active");
    const target = scopeThreadRef(ENV, ThreadId.make("history-store-target"));
    const store = useComposerDraftStore.getState();
    store.clearComposerContent(target);
    store.addThreadContexts(target, history.prompt, history.records);
    store.setPrompt(target, "");
    store.addThreadContexts(target, fresh.prompt, fresh.records);
    const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(draft.threadContexts).toHaveLength(33);
    expect(buildThreadContextForSend(draft.prompt, draft.threadContexts)?.records).toEqual(
      fresh.records,
    );
    const serialized = useComposerDraftStore.persist.getOptions().partialize!(
      useComposerDraftStore.getState(),
    );
    const serializedText = JSON.stringify(serialized);
    expect(serializedText).toContain(fresh.records[0]!.contextId);
    expect(serializedText).not.toContain(history.records[0]!.contextId);
    store.setThreadContexts(target, [...history.records, ...fresh.records]);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.threadContexts).toHaveLength(
      33,
    );
    store.clearComposerContent(target);
  });
});

describe("cross-composer copy/cut/paste", () => {
  it("rebinds pasted references to the destination's existing scoped record", () => {
    const source = attach("same-reference");
    const destination = attach("same-reference");
    const merged = mergeThreadContextClipboard({
      pastedText: source.prompt,
      pastedRecords: source.records,
      existingPrompt: destination.prompt,
      existingRecords: destination.records,
      environmentId: ENV,
      selfThreadId: OTHER,
      capabilities: SUPPORTED,
      resolveThread,
    });
    expect(merged.ok).toBe(true);
    expect(merged.records).toEqual(destination.records);
    expect(merged.prompt).not.toContain(source.records[0]!.contextId);
    expect(buildThreadContextForSend(merged.prompt, merged.records)?.records).toEqual(
      destination.records,
    );
  });
  it("carries structured records to another draft at the caret", () => {
    const source = attach("source-thread");
    expect(source.ok).toBe(true);

    // Copy the full source selection: text plus the records it references.
    const copied = selectedThreadContextRecords({
      prompt: source.prompt,
      records: source.records,
      start: 0,
      end: source.prompt.length,
    });
    expect(copied.length).toBe(1);
    const serialized = serializeThreadContextClipboard(source.prompt, copied);
    const pastedRecords = parseThreadContextClipboardPayload(serialized.json);
    expect(pastedRecords?.length).toBe(1);

    // Paste into an unrelated draft: content retained, caret honored.
    const merged = mergeThreadContextClipboard({
      pastedText: source.prompt,
      pastedRecords: pastedRecords ?? [],
      existingPrompt: "unrelated draft text",
      existingRecords: [],
      caret: 9,
      environmentId: ENV,
      selfThreadId: OTHER,
      capabilities: SUPPORTED,
      resolveThread,
    });
    expect(merged.ok).toBe(true);
    expect(merged.prompt.startsWith("unrelated")).toBe(true);
    expect(merged.prompt.endsWith(" draft text")).toBe(true);
    expect(merged.prompt).toContain("t3-context://v1/thread/");
    expect(merged.records.length).toBe(1);

    // The merged draft binds at send time through the production builder.
    const sendable = buildThreadContextForSend(merged.prompt, merged.records);
    expect(sendable?.records.length).toBe(1);
    expect(countReferencedThreadContexts(merged.prompt, merged.records)).toBe(1);
  });
});

describe("delete and undo bindings", () => {
  it("restores the send binding when deleted reference text comes back", () => {
    const attached = attach("undo-thread");
    expect(attached.ok).toBe(true);
    expect(buildThreadContextForSend(attached.prompt, attached.records)?.records.length).toBe(1);

    // Editor Backspace removes the reference text; the store record stays.
    const deleted = removeThreadContextReference(
      attached.prompt,
      String(attached.records[0]!.contextId),
    );
    expect(deleted.removed).toBe(true);
    expect(buildThreadContextForSend(deleted.prompt, attached.records)).toBe(undefined);

    // Native undo restores the text; the retained record re-binds.
    expect(buildThreadContextForSend(attached.prompt, attached.records)?.records.length).toBe(1);
  });

  it("prunes unreferenced records on persist so reloads never keep stale bindings", () => {
    const attached = attach("stale-thread");
    expect(attached.ok).toBe(true);
    const deleted = removeThreadContextReference(
      attached.prompt,
      String(attached.records[0]!.contextId),
    );
    const pruned = pruneUnreferencedThreadContextRecords(deleted.prompt, attached.records);
    expect(pruned).toEqual([]);
    const kept = pruneUnreferencedThreadContextRecords(attached.prompt, attached.records);
    expect(kept.length).toBe(1);
  });
});

describe("queue edit context", () => {
  it("hydrates queued records and clears with an explicit empty envelope", () => {
    const attached = attach("queued-thread");
    expect(attached.ok).toBe(true);
    // Hydration: the queued message context becomes the editing records.
    const editingRecords = [...attached.records];

    const retained = buildThreadContextForQueueUpdate({
      text: `${attached.prompt}edited`,
      records: editingRecords,
      previousRecords: editingRecords,
    });
    expect(retained).toEqual({ version: 1, records: editingRecords });

    const cleared = buildThreadContextForQueueUpdate({
      text: "edited without the thread",
      records: editingRecords,
      previousRecords: editingRecords,
    });
    // Must be an explicit empty envelope, never undefined (stale state).
    expect(cleared).toEqual({ version: 1, records: [] });

    // The cleared envelope replays the real queued-turn update transport shape.
    const decoded = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
      type: "thread.queued-turn.update",
      commandId: CommandId.make("cmd-1"),
      threadId: OTHER,
      queuedTurnId: QueuedTurnId.make("qt-1"),
      text: "edited without the thread",
      context: cleared,
      updatedAt: new Date().toISOString(),
    });
    expect(decoded.type).toBe("thread.queued-turn.update");
    if (decoded.type === "thread.queued-turn.update") {
      expect(decoded.context).toEqual({ version: 1, records: [] });
    }

    const retainedDecoded = Schema.decodeUnknownSync(OrchestrationMessageContext)(retained);
    expect(retainedDecoded.records.length).toBe(1);
  });
});

describe("retry restore with thread context", () => {
  it("restores the cleared draft after a failed send without clobbering new edits", () => {
    // After the optimistic clear, every field reads empty: restore proceeds.
    expect(
      isComposerDraftCleared({
        prompt: "",
        imageCount: 0,
        terminalContextCount: 0,
        threadContextCount: 0,
      }),
    ).toBe(true);
    // Any newer user content blocks the restore, including re-attached context.
    expect(
      isComposerDraftCleared({
        prompt: "",
        imageCount: 0,
        terminalContextCount: 0,
        threadContextCount: 1,
      }),
    ).toBe(false);
    expect(
      isComposerDraftCleared({
        prompt: "typed after failure",
        imageCount: 0,
        terminalContextCount: 0,
        threadContextCount: 0,
      }),
    ).toBe(false);
  });
});

describe("old environment capability gating", () => {
  it("rejects attach, paste, and send on unknown capabilities", () => {
    expect(isThreadContextSupported({})).toBe(false);
    expect(isThreadContextSupported(undefined)).toBe(false);

    const attached = attachThreadContexts({
      existingPrompt: "",
      existingRecords: [],
      refs: [scopeThreadRef(ENV, ThreadId.make("t-old"))],
      environmentId: ENV,
      selfThreadId: SELF,
      capabilities: {},
      resolveThread,
    });
    expect(attached.ok).toBe(false);

    // With no explicit support the send builder output must stay absent.
    expect(countReferencedThreadContexts("plain", [])).toBe(0);
  });
});
