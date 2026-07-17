import type { DesktopWslState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopWslStateAtom } from "./desktopWslState";

const wslState: DesktopWslState = {
  available: true,
  distro: null,
  distros: [
    {
      isDefault: true,
      name: "Ubuntu",
      version: 2,
    },
  ],
  enabled: true,
  preflightError: null,
  wslOnly: false,
};

describe("desktopWslState", () => {
  it("retains the loaded snapshot when the settings screen remounts", async () => {
    const getWslState = vi.fn(async () => wslState);
    const atom = createDesktopWslStateAtom(() => ({ getWslState }));
    const registry = AtomRegistry.make();

    const unmount = registry.mount(atom);
    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: wslState }),
      );
    });
    unmount();

    const remount = registry.mount(atom);
    expect(AsyncResult.value(registry.get(atom))).toEqual(
      expect.objectContaining({ _tag: "Some", value: wslState }),
    );
    expect(getWslState).toHaveBeenCalledTimes(1);

    remount();
    registry.dispose();
  });

  it("retains the desktop bridge failure as the load error cause", async () => {
    const cause = new Error("wsl unavailable");
    const atom = createDesktopWslStateAtom(() => ({
      getWslState: async () => Promise.reject(cause),
    }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected WSL state load to fail.");

    expect(Cause.squash(result.cause)).toEqual(
      expect.objectContaining({
        _tag: "DesktopWslStateLoadError",
        cause,
      }),
    );
    registry.dispose();
  });

  it("replaces cached state with refreshed live desktop state", async () => {
    const refreshedState: DesktopWslState = {
      ...wslState,
      preflightError: "WSL backend stopped unexpectedly.",
    };
    let currentState = wslState;
    const getWslState = vi.fn(async () => currentState);
    const atom = createDesktopWslStateAtom(() => ({ getWslState }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: wslState }),
      );
    });

    currentState = refreshedState;
    registry.refresh(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: refreshedState }),
      );
    });
    expect(getWslState).toHaveBeenCalledTimes(2);
    registry.dispose();
  });
});
