import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import { resolveThreadTabs } from "./ThreadTabStrip.logic";

const environmentId = EnvironmentId.make("environment-local");
const keyOf = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
const thread = (id: string, overrides: Parameters<typeof makeThreadFixture>[0] = {}) =>
  makeThreadFixture({ id: ThreadId.make(id), environmentId, title: id, ...overrides });
const working = {
  runtime: {
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    activeRunId: "run-1" as never,
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  },
};

describe("resolveThreadTabs", () => {
  const threads = [
    thread("idle"),
    thread("archived", { archivedAt: "2026-03-09T10:00:00.000Z" }),
    thread("busy", working),
    thread("busy-added", working),
  ];
  const resolve = (autoAddWorking: boolean) =>
    resolveThreadTabs({
      tabKeys: [keyOf("busy-added"), keyOf("gone"), keyOf("archived"), keyOf("idle")],
      threads,
      delegatedUnderParent: new Set(),
      localLastVisitedAtByKey: {},
      autoAddWorking,
    }).map((tab) => [tab.thread.title, tab.auto, tab.status?.label ?? null]);

  it("keeps added tabs in order and drops ones whose thread is gone or archived", () => {
    expect(resolve(false)).toEqual([
      ["busy-added", false, "Working"],
      ["idle", false, null],
    ]);
  });

  it("appends a tab for each other thread with a status while auto-add is on", () => {
    expect(resolve(true)).toEqual([
      ["busy-added", false, "Working"],
      ["idle", false, null],
      ["busy", true, "Working"],
    ]);
  });
});
