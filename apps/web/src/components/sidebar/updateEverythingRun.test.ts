import { EnvironmentId, type ServerSelfUpdateOutcome } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { toastManager } from "../ui/toast";
import { startDesktopUpdateLaunchNotice } from "./updateEverythingRun";

function relaunchWhileRestarting(environmentId: EnvironmentId, updateId?: string) {
  const now = 1_800_000_000_000;
  vi.useFakeTimers({ now });
  const store = new Map([
    [
      "t3code:update-everything-result:v1",
      JSON.stringify({
        savedAt: now,
        localVersion: null,
        updatedServers: 0,
        updatedProviders: 0,
        failures: [],
        handedOff: [
          {
            environmentId,
            label: "Slow",
            targetVersion: "9.9.9",
            startedAt: now,
            ...(updateId === undefined ? {} : { updateId }),
          },
        ],
      }),
    ],
  ]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
    },
  });
  return startDesktopUpdateLaunchNotice();
}

describe("startDesktopUpdateLaunchNotice", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a server that is still restarting from looking idle after the app relaunches", async () => {
    const environmentId = EnvironmentId.make("slow-machine");
    const stop = relaunchWhileRestarting(environmentId);
    try {
      // Lets the registry run its cleanup of unobserved atoms before the UI mounts.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(appAtomRegistry.get(serverEnvironment.updateStateAtom(environmentId))).toMatchObject({
        status: "running",
        stage: "resuming",
        targetVersion: "9.9.9",
      });
    } finally {
      await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
      stop();
    }
  });

  it("clears the restored state when the server never comes back", async () => {
    const environmentId = EnvironmentId.make("lost-machine");
    const stateAtom = serverEnvironment.updateStateAtom(environmentId);
    const stop = relaunchWhileRestarting(environmentId);
    // Observed like the UI does, so the registry cannot reset it by dropping the atom.
    const release = appAtomRegistry.mount(stateAtom);
    try {
      await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
      expect(appAtomRegistry.get(stateAtom)).toEqual({ status: "idle" });
    } finally {
      release();
      stop();
    }
  });

  it("reports this update's rollback instead of restarting until the timeout", async () => {
    const environmentId = EnvironmentId.make("rolled-back-machine");
    const stateAtom = serverEnvironment.updateStateAtom(environmentId);
    const outcomeAtom = Atom.make<AsyncResult.AsyncResult<ServerSelfUpdateOutcome>>(
      AsyncResult.initial(),
    );
    using _outcome = vi.spyOn(serverEnvironment, "updateOutcome").mockReturnValue(outcomeAtom);
    using addToast = vi.spyOn(toastManager, "add");
    const stop = relaunchWhileRestarting(environmentId, "update-2");
    const release = appAtomRegistry.mount(stateAtom);
    const outcome = (id: string, reason: string) =>
      AsyncResult.success<ServerSelfUpdateOutcome>({
        id,
        fromVersion: "9.9.8",
        targetVersion: "9.9.9",
        status: "rolled-back",
        reason,
      });
    try {
      expect(appAtomRegistry.get(stateAtom)).toMatchObject({
        status: "running",
        updateId: "update-2",
      });
      appAtomRegistry.set(outcomeAtom, outcome("update-1", "an earlier attempt"));
      expect(appAtomRegistry.get(stateAtom)).toMatchObject({ status: "running" });

      appAtomRegistry.set(outcomeAtom, outcome("update-2", "candidate-exited:78"));
      expect(appAtomRegistry.get(stateAtom)).toEqual({ status: "idle" });
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          description: expect.objectContaining({
            props: expect.objectContaining({ children: "Slow: candidate-exited:78" }),
          }),
        }),
      );
    } finally {
      release();
      stop();
    }
  });
});
