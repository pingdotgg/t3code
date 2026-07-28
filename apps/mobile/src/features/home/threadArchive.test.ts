import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import { threadCanArchive } from "./threadArchive";

function runtime(
  status: ThreadRuntimeSummary["status"],
  activeRunId: ThreadRuntimeSummary["activeRunId"],
): ThreadRuntimeSummary {
  return {
    status,
    activeRunId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "codex",
    lastError: null,
    updatedAt: "2026-07-28T10:00:00.000Z",
  };
}

describe("threadCanArchive", () => {
  it("blocks provider-active work", () => {
    const activeRunId = RunId.make("run-live");
    expect(threadCanArchive(runtime("preparing", activeRunId))).toBe(false);
    expect(threadCanArchive(runtime("starting", activeRunId))).toBe(false);
    expect(threadCanArchive(runtime("running", activeRunId))).toBe(false);
  });

  it("allows queued and post-provider waiting work despite a stale active run id", () => {
    const staleActiveRunId = RunId.make("run-finished");
    expect(threadCanArchive(runtime("queued", null))).toBe(true);
    expect(threadCanArchive(runtime("queued", staleActiveRunId))).toBe(true);
    expect(threadCanArchive(runtime("waiting", null))).toBe(true);
    expect(threadCanArchive(runtime("waiting", staleActiveRunId))).toBe(true);
  });
});
