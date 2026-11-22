import type { DesktopUpdateState } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktopUpdateStateAtom", () => {
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
});
