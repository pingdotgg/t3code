import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import type { ServerUpdateOutcome } from "../ServerUpdateAction";
import type { UpdateEverythingRun } from "./updateEverything.logic";
import {
  retryFailedUpdateRunServers,
  setUpdateEverythingRun,
  startDesktopUpdateLaunchNotice,
} from "./updateEverythingRun";

function relaunchWhileRestarting(environmentId: EnvironmentId) {
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
        handedOff: [{ environmentId, label: "Slow", targetVersion: "9.9.9", startedAt: now }],
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
});

describe("retryFailedUpdateRunServers", () => {
  it("settles a failed server that already restarted on the target and retries only the others", async () => {
    const targetVersion = "9.9.9";
    const serverVersions = new Map([
      [EnvironmentId.make("already-updated"), targetVersion],
      [EnvironmentId.make("behind"), "9.9.8"],
    ]);
    using _config = vi
      .spyOn(serverEnvironment, "configValueAtom")
      .mockImplementation((environmentId) =>
        Atom.make({
          environment: { serverVersion: serverVersions.get(environmentId!) },
        } as unknown as ServerConfig),
      );
    const rejection = "Remote updates must select a newer server version.";
    const failedMachine = (environmentId: EnvironmentId) => ({
      environmentId,
      label: environmentId,
      updatesProviders: false,
      server: {
        environmentId,
        serverLabel: environmentId,
        selfUpdate: "boot-service" as const,
        targetVersion,
      },
      handedOffVersion: null,
      startedAt: 0,
      result: "failed" as const,
      failure: rejection,
      providerFailure: null,
    });
    setUpdateEverythingRun(() => ({
      localVersion: null,
      phase: "servers",
      restartAt: null,
      machines: [...serverVersions.keys()].map(failedMachine),
    }));
    const update = vi.fn(async (): Promise<ServerUpdateOutcome> => ({
      status: "failed",
      message: rejection,
    }));

    retryFailedUpdateRunServers(update);
    await Promise.resolve();
    await Promise.resolve();

    let run: UpdateEverythingRun | null = null;
    setUpdateEverythingRun((current) => {
      run = current;
      return null;
    });
    expect(update.mock.calls.map(([target]) => target.environmentId)).toEqual(["behind"]);
    expect(
      (run as UpdateEverythingRun | null)?.machines.map(({ environmentId, result, server }) => ({
        environmentId,
        result,
        retryable: server !== null,
      })),
    ).toEqual([
      { environmentId: "already-updated", result: "done", retryable: false },
      { environmentId: "behind", result: "failed", retryable: true },
    ]);
  });
});
