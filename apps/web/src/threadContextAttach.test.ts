import { EnvironmentId, ThreadContextId, ThreadId } from "@t3tools/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isThreadContextSupported,
  mergeThreadContextClipboard,
  parseThreadContextClipboardPayload,
  selectedThreadContextRecords,
  selectThreadContextDescriptor,
  serializeThreadContextClipboard,
  THREAD_CONTEXT_CLIPBOARD_MIME,
  queryThreadContextCandidates,
  attachThreadContexts,
  type ThreadContextCandidate,
} from "./threadContextAttach";

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");

function candidate(
  overrides: Omit<Partial<ThreadContextCandidate>, "threadId"> & {
    threadId: string;
    title: string;
  },
): ThreadContextCandidate {
  return {
    environmentId: ENV_A,
    threadId: ThreadId.make(overrides.threadId),
    title: overrides.title,
    projectId: overrides.projectId ?? null,
    projectName: overrides.projectName ?? null,
    archivedAt: overrides.archivedAt ?? null,
    updatedAt: overrides.updatedAt ?? "2026-10-01T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-09-01T00:00:00.000Z",
    isDraft: overrides.isDraft ?? false,
  };
}

function selfThreadId(value: string) {
  return ThreadId.make(value);
}

function contextId(value: string) {
  return ThreadContextId.make(value);
}

describe("queryThreadContextCandidates", () => {
  it("returns empty for bare @ queries so file results stay unchanged", () => {
    const threads = [candidate({ threadId: "t-1", title: "Auth refactor" })];
    expect(
      queryThreadContextCandidates(threads, {
        query: "",
        environmentId: ENV_A,
        selfThreadId: ThreadId.make("self"),
      }),
    ).toEqual([]);
    expect(
      queryThreadContextCandidates(threads, {
        query: "   ",
        environmentId: ENV_A,
        selfThreadId: ThreadId.make("self"),
      }),
    ).toEqual([]);
  });

  it("matches same-env non-archived titles newest first, capped at 5, excluding self and drafts", () => {
    const threads = [
      candidate({ threadId: "old", title: "Auth refactor", updatedAt: "2026-08-01T00:00:00.000Z" }),
      candidate({
        threadId: "new",
        title: "Auth refactor v2",
        updatedAt: "2026-10-01T00:00:00.000Z",
      }),
      candidate({
        threadId: "arch",
        title: "Auth archived",
        archivedAt: "2026-09-01T00:00:00.000Z",
      }),
      candidate({ threadId: "self", title: "Auth self" }),
      candidate({ threadId: "draft-1", title: "Auth draft", isDraft: true }),
      candidate({ threadId: "other-env", title: "Auth foreign" }),
    ];
    // Mark the foreign thread as actually foreign.
    threads[5]!.environmentId = ENV_B;
    const results = queryThreadContextCandidates(threads, {
      query: "auth",
      environmentId: ENV_A,
      selfThreadId: ThreadId.make("self"),
    });
    const ids = results.map((entry) => String(entry.threadId));
    // Newest first, self/archived/draft/foreign excluded.
    expect(ids).toEqual(["new", "old"]);
  });

  it("caps at 5 newest matches and disambiguates duplicate titles with project", () => {
    const threads = Array.from({ length: 7 }, (_, index) =>
      candidate({
        threadId: `t-${index}`,
        title: `Deploy pipeline ${index % 2 === 0 ? "same" : "same"}`,
        projectName: `project-${index}`,
        updatedAt: `2026-10-0${(index % 9) + 1}T00:00:00.000Z`,
      }),
    );
    const results = queryThreadContextCandidates(threads, {
      query: "same",
      environmentId: ENV_A,
      selfThreadId: ThreadId.make("self"),
    });
    expect(results.length).toBe(5);
    // Duplicate titles carry project disambiguation.
    for (const entry of results) {
      expect(entry.displayLabel.length).toBeGreaterThan(0);
      expect(entry.disambiguation).toBeDefined();
    }
  });
});

describe("attachThreadContexts", () => {
  it("rejects self-attachment with no mutation", () => {
    const outcome = attachThreadContexts({
      existingPrompt: "hello ",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: ThreadId.make("self") }],
      environmentId: ENV_A,
      selfThreadId: ThreadId.make("self"),
      capabilities: { threadContext: true },
      resolveThread: (ref) => (String(ref.threadId) === "self" ? { title: "Self" } : null),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/self/i);
    expect(outcome.prompt).toBe("hello ");
    expect(outcome.records).toEqual([]);
  });

  it("rejects foreign and mixed-environment batches atomically", () => {
    const outcome = attachThreadContexts({
      existingPrompt: "",
      existingRecords: [],
      refs: [
        { environmentId: ENV_A, threadId: ThreadId.make("t-1") },
        { environmentId: ENV_B, threadId: ThreadId.make("t-2") },
      ],
      environmentId: ENV_A,
      selfThreadId: ThreadId.make("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "T" }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/environment/i);
    expect(outcome.prompt).toBe("");
    expect(outcome.records).toEqual([]);
  });

  it("rejects dangling threads and old servers without mutation", () => {
    const dangling = attachThreadContexts({
      existingPrompt: "x",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: ThreadId.make("missing") }],
      environmentId: ENV_A,
      selfThreadId: ThreadId.make("self"),
      capabilities: { threadContext: true },
      resolveThread: () => null,
    });
    expect(dangling.ok).toBe(false);
    expect(dangling.prompt).toBe("x");

    const gated = attachThreadContexts({
      existingPrompt: "x",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: ThreadId.make("t-1") }],
      environmentId: ENV_A,
      selfThreadId: ThreadId.make("self"),
      capabilities: { threadContext: false },
      resolveThread: () => ({ title: "T" }),
    });
    expect(gated.ok).toBe(false);
    expect(gated.reason).toMatch(/server|support|capabilit/i);
  });

  it("dedups already-attached threads and enforces the 32-record limit", () => {
    const existingRecords = [
      {
        version: 1 as const,
        kind: "thread" as const,
        contextId: contextId("ctx-t-1"),
        label: "T 1",
        environmentId: ENV_A,
        threadId: selfThreadId("t-1"),
        title: "T 1",
      },
    ];
    const dedup = attachThreadContexts({
      existingPrompt: "[T 1](t3-context://v1/thread/ctx-t-1) ",
      existingRecords,
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-1") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "T 1" }),
    });
    expect(dedup.ok).toBe(true);
    expect(dedup.records.length).toBe(1);
    expect(dedup.prompt).toBe("[T 1](t3-context://v1/thread/ctx-t-1) ");

    const full = Array.from({ length: 32 }, (_, index) => ({
      version: 1 as const,
      kind: "thread" as const,
      contextId: contextId(`ctx-${index}`),
      label: `T ${index}`,
      environmentId: ENV_A,
      threadId: selfThreadId(`t-${index}`),
      title: `T ${index}`,
    }));
    const overflow = attachThreadContexts({
      existingPrompt: "",
      existingRecords: full,
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-new") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "T new" }),
    });
    expect(overflow.ok).toBe(false);
    expect(overflow.records.length).toBe(32);
  });

  it("inserts a reference at the caret with trailing space", () => {
    const outcome = attachThreadContexts({
      existingPrompt: "hello ",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-9") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "Auth refactor" }),
      caret: 6,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.records.length).toBe(1);
    expect(outcome.prompt).toContain("t3-context://v1/thread/");
    expect(outcome.prompt.endsWith(" ")).toBe(true);
    expect(outcome.cursor).toBe(outcome.prompt.length);
  });
});

describe("thread context clipboard", () => {
  it("round-trips structured references through text", () => {
    const attached = attachThreadContexts({
      existingPrompt: "",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-3") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "Clipboard thread" }),
    });
    expect(attached.ok).toBe(true);
    const serialized = serializeThreadContextClipboard(attached.prompt, attached.records);
    expect(serialized.text).toContain("t3-context://v1/thread/");
    const pastedRecords = parseThreadContextClipboardPayload(serialized.json);
    const merged = mergeThreadContextClipboard({
      pastedText: serialized.text,
      pastedRecords: pastedRecords ?? [],
      existingPrompt: "",
      existingRecords: [],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "Clipboard thread" }),
    });
    expect(merged.ok).toBe(true);
    expect(merged.records.length).toBe(1);
  });
});

describe("thread context capability gating", () => {
  it("enables thread context only on an explicit true capability", () => {
    expect(isThreadContextSupported({ capabilities: { threadContext: true } })).toBe(true);
    expect(isThreadContextSupported({ capabilities: { threadContext: false } })).toBe(false);
    expect(isThreadContextSupported({ capabilities: {} })).toBe(false);
    expect(isThreadContextSupported({})).toBe(false);
    expect(isThreadContextSupported(null)).toBe(false);
    expect(isThreadContextSupported(undefined)).toBe(false);
  });

  it("resolves the selected environment descriptor, never the primary for foreign envs", () => {
    const primary = {
      environmentId: ENV_A,
      label: "primary",
      platform: "local" as const,
      serverVersion: "1",
      capabilities: { threadContext: true },
    };
    const saved = {
      environmentId: ENV_B,
      label: "saved",
      platform: "local" as const,
      serverVersion: "1",
      capabilities: { threadContext: false },
    };
    expect(
      selectThreadContextDescriptor({
        environmentId: ENV_A,
        primaryDescriptor: primary,
        savedDescriptor: saved,
      }),
    ).toBe(primary);
    expect(
      selectThreadContextDescriptor({
        environmentId: ENV_B,
        primaryDescriptor: primary,
        savedDescriptor: saved,
      }),
    ).toBe(saved);
    expect(
      selectThreadContextDescriptor({
        environmentId: ENV_B,
        primaryDescriptor: primary,
        savedDescriptor: null,
      }),
    ).toBe(null);
  });

  it("rejects attach and paste on unknown capabilities without mutation", () => {
    const attach = attachThreadContexts({
      existingPrompt: "x",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-1") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: {},
      resolveThread: () => ({ title: "T" }),
    });
    expect(attach.ok).toBe(false);
    expect(attach.prompt).toBe("x");

    const merged = mergeThreadContextClipboard({
      pastedText: "pasted",
      pastedRecords: [],
      existingPrompt: "draft",
      existingRecords: [],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: {},
      resolveThread: () => ({ title: "T" }),
    });
    expect(merged.ok).toBe(false);
    expect(merged.prompt).toBe("draft");
  });
});

describe("thread context scoped identity", () => {
  it("ships without NUL bytes so Git never treats the module as binary", () => {
    const source = readFileSync(new URL("./threadContextAttach.ts", import.meta.url), "utf8");
    expect(source.includes("\0")).toBe(false);
  });

  it("scopes the same thread id on two environments to distinct grammar-safe identities", () => {
    const resolveThread = () => ({ title: "Shared id" });
    const first = attachThreadContexts({
      existingPrompt: "",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("same") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread,
    });
    expect(first.ok).toBe(true);
    const second = attachThreadContexts({
      existingPrompt: first.prompt,
      existingRecords: first.records,
      refs: [{ environmentId: ENV_B, threadId: selfThreadId("same") }],
      environmentId: ENV_B,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread,
    });
    expect(second.ok).toBe(true);
    expect(second.records.length).toBe(2);
    const [recordA, recordB] = second.records;
    expect(recordA!.environmentId).toBe(ENV_A);
    expect(recordB!.environmentId).toBe(ENV_B);
    expect(String(recordA!.contextId)).not.toBe(String(recordB!.contextId));
    for (const record of second.records) {
      expect(String(record.contextId)).toMatch(/^[a-z0-9_-]{1,128}$/i);
    }
  });

  it("re-inserts reference text for a stored record whose text was deleted", () => {
    const attached = attachThreadContexts({
      existingPrompt: "",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-7") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "Reinsert me" }),
    });
    expect(attached.ok).toBe(true);
    // The editor text was deleted (Backspace on the chip); the store record stays.
    const reinserted = attachThreadContexts({
      existingPrompt: "follow up ",
      existingRecords: attached.records,
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-7") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "Reinsert me" }),
      caret: 10,
    });
    expect(reinserted.ok).toBe(true);
    expect(reinserted.records.length).toBe(1);
    expect(reinserted.records[0]!.contextId).toBe(attached.records[0]!.contextId);
    expect(reinserted.prompt).toContain("t3-context://v1/thread/");
    expect(reinserted.prompt.startsWith("follow up ")).toBe(true);
  });
});

describe("thread context structured clipboard", () => {
  it("serializes selection records to MIME/JSON/HTML and validates them with shared schemas", () => {
    const attached = attachThreadContexts({
      existingPrompt: "",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-clip") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "Clip thread" }),
    });
    expect(attached.ok).toBe(true);
    const serialized = serializeThreadContextClipboard(attached.prompt, attached.records);
    expect(serialized.mimeType).toBe(THREAD_CONTEXT_CLIPBOARD_MIME);
    expect(serialized.text).toContain("t3-context://v1/thread/");
    expect(serialized.html).toContain("t3-context://v1/thread/");
    const parsed = parseThreadContextClipboardPayload(serialized.json);
    expect(parsed?.length).toBe(1);
    expect(String(parsed![0]!.threadId)).toBe("t-clip");

    expect(parseThreadContextClipboardPayload("not-json")).toBe(null);
    expect(
      parseThreadContextClipboardPayload(
        JSON.stringify({ version: 1, records: [{ kind: "thread" }] }),
      ),
    ).toBe(null);
    expect(
      parseThreadContextClipboardPayload(
        JSON.stringify({
          version: 2,
          records: [],
        }),
      ),
    ).toBe(null);
  });

  it("selects only records referenced inside the copied range", () => {
    const first = attachThreadContexts({
      existingPrompt: "",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-a") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: (ref) => ({ title: `Title ${String(ref.threadId)}` }),
    });
    const second = attachThreadContexts({
      existingPrompt: `${first.prompt}middle `,
      existingRecords: first.records,
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-b") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: (ref) => ({ title: `Title ${String(ref.threadId)}` }),
    });
    expect(second.ok).toBe(true);
    const refStart = second.prompt.indexOf("middle ");
    const selected = selectedThreadContextRecords({
      prompt: second.prompt,
      records: second.records,
      start: refStart,
      end: second.prompt.length,
    });
    expect(selected.map((record) => String(record.threadId))).toEqual(["t-b"]);
  });

  it("merges pasted thread context at the caret retaining unrelated draft content", () => {
    const source = attachThreadContexts({
      existingPrompt: "",
      existingRecords: [],
      refs: [{ environmentId: ENV_A, threadId: selfThreadId("t-src") }],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "Source thread" }),
    });
    expect(source.ok).toBe(true);
    const serialized = serializeThreadContextClipboard(`see this ${source.prompt}`, source.records);
    const pastedRecords = parseThreadContextClipboardPayload(serialized.json);
    expect(pastedRecords?.length).toBe(1);
    const merged = mergeThreadContextClipboard({
      pastedText: serialized.text,
      pastedRecords: pastedRecords ?? [],
      existingPrompt: "hello world",
      existingRecords: [],
      caret: 5,
      environmentId: ENV_A,
      selfThreadId: selfThreadId("other"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "Source thread" }),
    });
    expect(merged.ok).toBe(true);
    expect(merged.prompt.startsWith("hello")).toBe(true);
    expect(merged.prompt.endsWith(" world")).toBe(true);
    expect(merged.prompt).toContain("t3-context://v1/thread/");
    expect(merged.records.length).toBe(1);
    expect(merged.cursor).toBeGreaterThan(5);
  });

  it("rejects foreign, self, and dangling pastes atomically", () => {
    const foreign = mergeThreadContextClipboard({
      pastedText: "[X](t3-context://v1/thread/ctx-x) ",
      pastedRecords: [
        {
          version: 1 as const,
          kind: "thread" as const,
          contextId: ThreadContextId.make("ctx-x"),
          label: "X",
          environmentId: ENV_B,
          threadId: ThreadId.make("t-x"),
          title: "X",
        },
      ],
      existingPrompt: "draft",
      existingRecords: [],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => ({ title: "X" }),
    });
    expect(foreign.ok).toBe(false);
    expect(foreign.prompt).toBe("draft");
    expect(foreign.records).toEqual([]);

    const dangling = mergeThreadContextClipboard({
      pastedText: "[Y](t3-context://v1/thread/ctx-y) ",
      pastedRecords: [
        {
          version: 1 as const,
          kind: "thread" as const,
          contextId: ThreadContextId.make("ctx-y"),
          label: "Y",
          environmentId: ENV_A,
          threadId: ThreadId.make("t-y"),
          title: "Y",
        },
      ],
      existingPrompt: "draft",
      existingRecords: [],
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
      resolveThread: () => null,
    });
    expect(dangling.ok).toBe(false);
    expect(dangling.prompt).toBe("draft");
  });
});
