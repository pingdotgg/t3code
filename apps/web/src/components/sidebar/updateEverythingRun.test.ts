import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { EnvironmentId, type ServerConfig, type ServerSelfUpdateOutcome } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { toastManager } from "../ui/toast";
import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";
import type { RestoredRetry, UpdateEverythingRun } from "./updateEverything.logic";
import {
  retryFailedUpdateRunServers,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  startDesktopUpdateLaunchNotice,
} from "./updateEverythingRun";

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

  it("keeps a restored track switch out of the capsule's retry", async () => {
    const environmentId = EnvironmentId.make("switching-machine");
    const now = 1_800_000_000_000;
    vi.useFakeTimers({ now });
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });
    setUpdateEverythingRun(() => ({
      trackSwitch: true,
      localVersion: "9.9.9",
      phase: "installing",
      restartAt: null,
      machines: [
        {
          environmentId,
          label: "Switching",
          updatesProviders: false,
          server: null,
          handedOffVersion: "9.9.9",
          startedAt: now,
          result: null,
          failure: null,
          providerFailure: null,
        },
      ],
    }));
    saveUpdateEverythingResult({
      localVersion: "9.9.9",
      updatedServers: 0,
      updatedProviders: 0,
      failures: [],
      restarting: [],
    });
    setUpdateEverythingRun(() => null);

    const stop = startDesktopUpdateLaunchNotice();
    let run: UpdateEverythingRun | null = null;
    setUpdateEverythingRun((current) => (run = current));
    try {
      expect(run).toMatchObject({ trackSwitch: true, machines: [{ environmentId }] });
    } finally {
      await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
      stop();
      setUpdateEverythingRun(() => null);
    }
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

  it("retries the connection to a restarting server instead of waiting out its backoff", async () => {
    const environmentId = EnvironmentId.make("backing-off-machine");
    using _connection = vi
      .spyOn(environmentCatalog, "stateAtom")
      .mockReturnValue(
        Atom.make(
          AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase: "backoff" as const }),
        ) as unknown as ReturnType<typeof environmentCatalog.stateAtom>,
      );
    using retryNow = vi.spyOn(environmentCatalog.retryNow, "run").mockReturnValue(Effect.void);
    const stop = relaunchWhileRestarting(environmentId);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(retryNow).toHaveBeenCalledWith(appAtomRegistry, environmentId);
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

      appAtomRegistry.set(outcomeAtom, outcome("update-2", "candidate-exited:1"));
      expect(appAtomRegistry.get(stateAtom)).toEqual({ status: "idle" });
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          description: expect.objectContaining({
            props: expect.objectContaining({ children: "Slow: candidate-exited:1" }),
          }),
        }),
      );
    } finally {
      release();
      stop();
    }
  });
});

describe("retryFailedUpdateRunServers", () => {
  it("settles a failed server that already restarted on the target and retries only the others", () => {
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
    const update = vi.fn(
      (_target: ServerUpdateTarget) => new Promise<ServerUpdateOutcome>(() => {}),
    );

    retryFailedUpdateRunServers(update);

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
      { environmentId: "behind", result: null, retryable: true },
    ]);
  });

  it("retries a row restored after a relaunch with the target it is given", () => {
    const environmentId = EnvironmentId.make("restored");
    const currentId = EnvironmentId.make("restored-current");
    // Rendered as current, but the server went back to the old version before the click.
    const staleId = EnvironmentId.make("restored-stale");
    using _config = vi.spyOn(serverEnvironment, "configValueAtom").mockImplementation((id) =>
      Atom.make({
        environment: { serverVersion: id === currentId ? "9.9.9" : "9.9.8" },
      } as unknown as ServerConfig),
    );
    setUpdateEverythingRun(() => ({
      localVersion: null,
      phase: "servers",
      restartAt: null,
      machines: [
        {
          environmentId,
          label: "restored",
          updatesProviders: false,
          server: null,
          handedOffVersion: "9.9.9",
          startedAt: 0,
          result: "failed",
          failure: "Not back after 32 minutes",
          providerFailure: null,
        },
        {
          environmentId: currentId,
          label: "restored-current",
          updatesProviders: false,
          server: null,
          handedOffVersion: "9.9.9",
          startedAt: 0,
          result: "failed",
          failure: "Not back after 32 minutes",
          providerFailure: null,
        },
        {
          environmentId: staleId,
          label: "restored-stale",
          updatesProviders: false,
          server: null,
          handedOffVersion: "9.9.9",
          startedAt: 0,
          result: "failed",
          failure: "Not back after 32 minutes",
          providerFailure: null,
        },
      ],
    }));
    const target: ServerUpdateTarget = {
      environmentId,
      serverLabel: "restored",
      selfUpdate: "boot-service",
      targetVersion: "9.9.9",
    };
    const update = vi.fn(
      (_target: ServerUpdateTarget) => new Promise<ServerUpdateOutcome>(() => {}),
    );

    retryFailedUpdateRunServers(
      update,
      new Map<EnvironmentId, RestoredRetry>([
        [environmentId, target],
        [currentId, "current"],
        [staleId, "current"],
      ]),
    );

    let run: UpdateEverythingRun | null = null;
    setUpdateEverythingRun((current) => {
      run = current;
      return null;
    });
    expect(update.mock.calls.map(([called]) => called)).toEqual([target]);
    // Downloading again, not "restarting" from the old handoff, and retryable if it fails again.
    expect((run as UpdateEverythingRun | null)?.machines).toMatchObject([
      { result: null, server: target, handedOffVersion: null },
      { result: "done", failure: null },
      { result: "failed", failure: "Not back after 32 minutes" },
    ]);
  });
});
