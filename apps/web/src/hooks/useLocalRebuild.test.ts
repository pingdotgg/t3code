import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopLocalRebuildLifecycle,
  DesktopLocalRebuildStaleness,
} from "@t3tools/contracts";

import { useLocalRebuildStaleness, useRequestLocalRebuild } from "./useLocalRebuild";

const staleness: DesktopLocalRebuildStaleness = {
  available: true,
  behind: false,
  behindBy: null,
  readyToPull: true,
  readinessReason: null,
  localBranch: "main",
  localSha: "a".repeat(40),
  remoteBranch: "main",
  remoteSha: "a".repeat(40),
  buildSha: "a".repeat(40),
  checkedAt: new Date(0).toISOString(),
  error: null,
};

let renderer: ReactTestRenderer | null = null;

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "confirm");
});

describe("local rebuild hooks", () => {
  it("keeps a pending check owned across interval changes, including zero", async () => {
    let resolveCheck!: (value: DesktopLocalRebuildStaleness) => void;
    const checkLocalRebuildStaleness = vi.fn(
      () =>
        new Promise<DesktopLocalRebuildStaleness>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { desktopBridge: { checkLocalRebuildStaleness }, confirm: () => true },
    });
    let poll = { staleness: null, checking: false } as ReturnType<typeof useLocalRebuildStaleness>;

    function Probe({ intervalMinutes }: { intervalMinutes: number }) {
      poll = useLocalRebuildStaleness({ enabled: true, intervalMinutes });
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Probe, { intervalMinutes: 15 }));
      await Promise.resolve();
    });
    expect(checkLocalRebuildStaleness).toHaveBeenCalledOnce();
    expect(poll.checking).toBe(true);

    await act(async () => {
      renderer?.update(createElement(Probe, { intervalMinutes: 0 }));
    });
    expect(checkLocalRebuildStaleness).toHaveBeenCalledOnce();
    expect(poll.checking).toBe(true);

    await act(async () => {
      resolveCheck(staleness);
      await Promise.resolve();
    });
    expect(poll).toEqual({ staleness, checking: false });
  });

  it("keeps rebuild busy until the shared lifecycle reports completion or failure", async () => {
    const idle: DesktopLocalRebuildLifecycle = {
      revision: 0,
      phase: "idle",
      logPath: null,
      message: null,
    };
    let current = idle;
    const listeners = new Set<(state: DesktopLocalRebuildLifecycle) => void>();
    const publish = (state: DesktopLocalRebuildLifecycle) => {
      current = state;
      for (const listener of listeners) listener(state);
    };
    const desktopBridge = {
      getLocalRebuildLifecycle: vi.fn(async () => current),
      onLocalRebuildLifecycleChanged: vi.fn(
        (listener: (state: DesktopLocalRebuildLifecycle) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      ),
      rebuildAndRestart: vi.fn(async () => {
        publish({ revision: 1, phase: "running", logPath: "/tmp/dev-rebuild.log", message: null });
        return { accepted: true, logPath: "/tmp/dev-rebuild.log", message: null };
      }),
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { desktopBridge, confirm: () => true },
    });
    let request: ReturnType<typeof useRequestLocalRebuild> = {
      requestLocalRebuild: () => {},
      isStartingLocalRebuild: false,
      lifecycle: null,
    };
    let lifecycle: DesktopLocalRebuildLifecycle | null = null;

    function Probe() {
      request = useRequestLocalRebuild();
      lifecycle = request.lifecycle;
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Probe));
      await Promise.resolve();
    });
    await act(async () => {
      request.requestLocalRebuild();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(request.isStartingLocalRebuild).toBe(true);
    expect(lifecycle).toMatchObject({ phase: "running", logPath: "/tmp/dev-rebuild.log" });

    act(() => {
      publish({
        revision: 2,
        phase: "failed",
        logPath: "/tmp/dev-rebuild.log",
        message: "Installer exited with code 1.",
      });
    });
    expect(request.isStartingLocalRebuild).toBe(false);
    expect(lifecycle).toMatchObject({
      phase: "failed",
      message: "Installer exited with code 1.",
      logPath: "/tmp/dev-rebuild.log",
    });
  });

  it("admits only one request before the running lifecycle broadcast arrives", async () => {
    const idle: DesktopLocalRebuildLifecycle = {
      revision: 0,
      phase: "idle",
      logPath: null,
      message: null,
    };
    let resolveRequest!: (result: {
      accepted: boolean;
      logPath: string | null;
      message: string | null;
    }) => void;
    const rebuildAndRestart = vi.fn(
      () =>
        new Promise<{
          accepted: boolean;
          logPath: string | null;
          message: string | null;
        }>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const desktopBridge = {
      getLocalRebuildLifecycle: vi.fn(async () => idle),
      onLocalRebuildLifecycleChanged: vi.fn(() => () => {}),
      rebuildAndRestart,
    };
    const confirm = vi.fn(() => true);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { desktopBridge, confirm },
    });
    let request: ReturnType<typeof useRequestLocalRebuild> = {
      requestLocalRebuild: () => {},
      isStartingLocalRebuild: false,
      lifecycle: null,
    };

    function Probe() {
      request = useRequestLocalRebuild();
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Probe));
      await Promise.resolve();
    });

    act(() => {
      request.requestLocalRebuild();
      request.requestLocalRebuild();
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(rebuildAndRestart).toHaveBeenCalledOnce();

    await act(async () => {
      resolveRequest({ accepted: true, logPath: "/tmp/dev-rebuild.log", message: null });
      await Promise.resolve();
    });
  });
});
