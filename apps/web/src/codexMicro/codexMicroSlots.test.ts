import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import {
  assignCodexMicroSlots,
  codexMicroSlotStatus,
  EMPTY_CODEX_MICRO_SLOTS,
} from "./codexMicroSlots";

const NOW = "2026-10-22T12:00:00.000Z";
const running = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: NOW,
};

const thread = (id: string, overrides: ThreadFixtureOverrides = {}) =>
  makeThreadFixture({
    id: ThreadId.make(id),
    title: id,
    updatedAt: "2026-10-22T10:00:00.000Z",
    ...overrides,
  });

const assign = (
  threads: ReturnType<typeof thread>[],
  options: Partial<Parameters<typeof assignCodexMicroSlots>[0]> = {},
) =>
  assignCodexMicroSlots({
    threads,
    previous: EMPTY_CODEX_MICRO_SLOTS,
    mode: "priority",
    pinnedThreads: [],
    now: NOW,
    ...options,
  });

describe("codexMicroSlotStatus", () => {
  it("folds sidebar states into device colors", () => {
    expect(codexMicroSlotStatus(thread("a", { hasPendingApprovals: true, runtime: running }))).toBe(
      "needs-input",
    );
    expect(codexMicroSlotStatus(thread("a", { runtime: running }))).toBe("working");
    expect(codexMicroSlotStatus(thread("a"))).toBe("idle");
  });
});

describe("assignCodexMicroSlots", () => {
  it("puts urgent threads first, then keeps them on their keys", () => {
    const first = assign([thread("idle"), thread("run", { runtime: running })]);
    expect(first.map((slot) => slot.threadId).slice(0, 2)).toEqual(["run", "idle"]);

    // "idle" now needs input and outranks "run", but it must not jump keys.
    const next = assign(
      [thread("idle", { hasPendingApprovals: true }), thread("run", { runtime: running })],
      { previous: first },
    );
    expect(next.map((slot) => slot.threadId).slice(0, 2)).toEqual(["run", "idle"]);
    expect(next[1]?.status).toBe("needs-input");
  });

  it("skips settled, archived and snoozed threads unless they're live", () => {
    const slots = assign([
      thread("settled", { settledAt: NOW }),
      thread("archived", { archivedAt: NOW, runtime: running }),
      thread("snoozed", { snoozedUntil: "2026-10-23T00:00:00.000Z" }),
      thread("settled-but-running", { settledAt: NOW, runtime: running }),
    ]);
    expect(slots.map((slot) => slot.threadId).filter(Boolean)).toEqual(["settled-but-running"]);
  });

  it("honours pins and the pinned/recent modes", () => {
    const threads = [
      thread("p2", { pinnedAt: NOW, pinOrderKey: "b" }),
      thread("p1", { pinnedAt: NOW, pinOrderKey: "a" }),
      thread("new", { updatedAt: "2026-10-22T11:00:00.000Z", settledAt: NOW }),
    ];
    expect(
      assign(threads, { mode: "pinned" })
        .map((slot) => slot.threadId)
        .slice(0, 3),
    ).toEqual(["p1", "p2", null]);
    expect(assign(threads, { mode: "recent" })[0]?.threadId).toBe("new");
    const pinned = assign(threads, { pinnedThreads: [null, null, null, null, null, "new"] });
    expect(pinned[5]?.threadId).toBe("new");
  });
});
