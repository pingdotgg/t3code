import type { DesktopUpdateState } from "@t3tools/contracts";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopUpdateStateAtom } from "./desktopUpdate";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktopUpdateStateAtom", () => {
  it("loads once, retains state, and follows desktop update events", async () => {
    let listener: ((state: DesktopUpdateState) => void) | undefined;
    const unsubscribe = vi.fn();
    const getUpdateState = vi.fn(async () => baseState);
    const onUpdateState = vi.fn((nextListener: (state: DesktopUpdateState) => void) => {
      listener = nextListener;
      return unsubscribe;
    });
    const atom = createDesktopUpdateStateAtom(() => ({ getUpdateState, onUpdateState }));
    const registry = AtomRegistry.make();

    const unmount = registry.mount(atom);
    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toEqual(baseState);
    });

    const downloadedState: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };
    listener?.(downloadedState);

    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toEqual(downloadedState);
    });
    unmount();

    const remount = registry.mount(atom);
    expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toEqual(downloadedState);
    expect(getUpdateState).toHaveBeenCalledTimes(1);
    expect(onUpdateState).toHaveBeenCalledTimes(1);

    remount();
    registry.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not let a slower initial read overwrite a newer update event", async () => {
    let resolveInitial: ((state: DesktopUpdateState) => void) | undefined;
    let listener: ((state: DesktopUpdateState) => void) | undefined;
    const atom = createDesktopUpdateStateAtom(() => ({
      getUpdateState: () =>
        new Promise<DesktopUpdateState>((resolve) => {
          resolveInitial = resolve;
        }),
      onUpdateState: (nextListener) => {
        listener = nextListener;
        return () => undefined;
      },
    }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(listener).toBeDefined());
    const newerState: DesktopUpdateState = { ...baseState, status: "checking" };
    listener?.(newerState);
    resolveInitial?.(baseState);

    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toEqual(newerState);
    });
    registry.dispose();
  });

  it("keeps listening when the initial desktop state read fails", async () => {
    let listener: ((state: DesktopUpdateState) => void) | undefined;
    const atom = createDesktopUpdateStateAtom(() => ({
      getUpdateState: async () => Promise.reject(new Error("IPC unavailable")),
      onUpdateState: (nextListener) => {
        listener = nextListener;
        return () => undefined;
      },
    }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.(baseState);
    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toEqual(baseState);
    });
    registry.dispose();
  });
});
