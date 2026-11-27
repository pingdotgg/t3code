import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  navigateAfterThreadDeletion,
  threadRuntimeBlocksContinueOnMachine,
} from "./useThreadActions";
import { toastManager } from "../components/ui/toast";

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });
});

describe("threadRuntimeBlocksContinueOnMachine", () => {
  function runtime(
    status: ThreadRuntimeSummary["status"],
    activeRunId: RunId | null = null,
  ): ThreadRuntimeSummary {
    return {
      status,
      activeRunId,
      providerInstanceId: ProviderInstanceId.make("claude-default"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-11-27T00:00:00.000Z",
    };
  }

  it.each(["preparing", "starting", "running", "waiting"] as const)(
    "blocks while a run is %s, as the server does",
    (status) => {
      expect(threadRuntimeBlocksContinueOnMachine(runtime(status, RunId.make("run-1")))).toBe(true);
    },
  );

  it("blocks a queued run that waits behind an active one", () => {
    expect(threadRuntimeBlocksContinueOnMachine(runtime("queued", RunId.make("run-1")))).toBe(true);
  });

  it.each([
    ["an idle thread", runtime("idle")],
    ["a completed run", runtime("completed")],
    ["a queued run with no active run", runtime("queued")],
    ["a thread with no runtime yet", null],
  ])("allows %s", (_, value) => {
    expect(threadRuntimeBlocksContinueOnMachine(value)).toBe(false);
  });
});
