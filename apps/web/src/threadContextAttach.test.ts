import { EnvironmentId, ThreadContextId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  exportThreadContextClipboard,
  importThreadContextClipboard,
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
      resolveThread: (ref) =>
        String(ref.threadId) === "self" ? { title: "Self", projectName: null } : null,
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
      resolveThread: () => ({ title: "T", projectName: null }),
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
      resolveThread: () => ({ title: "T", projectName: null }),
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
      resolveThread: () => ({ title: "T 1", projectName: null }),
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
      resolveThread: () => ({ title: "T new", projectName: null }),
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
      resolveThread: () => ({ title: "Auth refactor", projectName: null }),
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
      resolveThread: () => ({ title: "Clipboard thread", projectName: null }),
    });
    expect(attached.ok).toBe(true);
    const exported = exportThreadContextClipboard(attached.prompt, attached.records);
    expect(exported.text).toContain("t3-context://v1/thread/");
    const imported = importThreadContextClipboard(exported.text, exported.records, {
      environmentId: ENV_A,
      selfThreadId: selfThreadId("self"),
      capabilities: { threadContext: true },
    });
    expect(imported.ok).toBe(true);
    expect(imported.records.length).toBe(1);
  });
});
