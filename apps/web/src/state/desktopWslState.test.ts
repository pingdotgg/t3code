import type { DesktopWslState } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";

import { desktopWslStateAtom } from "./desktopWslState";

it("reloads WSL distributions when stale state is mounted again", async () => {
  const initial: DesktopWslState = {
    enabled: false,
    distro: null,
    available: true,
    wslOnly: false,
    distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
    preflightError: null,
  };
  let current = initial;
  vi.stubGlobal("window", { desktopBridge: { getWslState: async () => current } });
  using now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  try {
    const unmount = registry.mount(desktopWslStateAtom);
    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(registry.get(desktopWslStateAtom), () => null)).toEqual(initial);
    });
    unmount();
    for (const task of tasks.splice(0)) task();

    current = {
      ...initial,
      distros: [...initial.distros, { name: "Debian", isDefault: false, version: 2 }],
    };
    now.mockReturnValue(1_060_000);
    const unmountAgain = registry.mount(desktopWslStateAtom);
    try {
      await vi.waitFor(() => {
        expect(
          AsyncResult.getOrElse(registry.get(desktopWslStateAtom), () => null)?.distros,
          "Reopening stale WSL state should expose the current distributions",
        ).toEqual(current.distros);
      });
    } finally {
      unmountAgain();
    }
  } finally {
    registry.dispose();
    vi.unstubAllGlobals();
  }
});

it("refreshes distributions on Access entry while settings search stays subscribed", async () => {
  const { refreshDesktopWslState } = await import("./desktopWslState");
  const initial: DesktopWslState = {
    enabled: false,
    distro: null,
    available: true,
    wslOnly: false,
    distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
    preflightError: null,
  };
  let current = initial;
  vi.stubGlobal("window", { desktopBridge: { getWslState: async () => current } });
  const unmountSidebar = appAtomRegistry.mount(desktopWslStateAtom);
  const unmountView = appAtomRegistry.mount(desktopWslStateAtom);
  try {
    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(appAtomRegistry.get(desktopWslStateAtom), () => null)).toEqual(
        initial,
      );
    });
    unmountView();
    current = {
      ...initial,
      distros: [...initial.distros, { name: "Debian", isDefault: false, version: 2 }],
    };
    const unmountAgain = appAtomRegistry.mount(desktopWslStateAtom);
    try {
      refreshDesktopWslState();
      await vi.waitFor(() => {
        expect(
          AsyncResult.getOrElse(appAtomRegistry.get(desktopWslStateAtom), () => null)?.distros,
        ).toEqual(current.distros);
      });
    } finally {
      unmountAgain();
    }
  } finally {
    unmountSidebar();
    appAtomRegistry.reset();
    vi.unstubAllGlobals();
  }
});
