import type { DesktopWslState } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

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

it("refreshes on every Access visit while Search keeps its cached data", async () => {
  const { desktopWslAccessStateAtom } = await import("./desktopWslState");
  const initial: DesktopWslState = {
    enabled: false,
    distro: null,
    available: true,
    wslOnly: false,
    distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
    preflightError: null,
  };
  const updated: DesktopWslState = {
    ...initial,
    distros: [...initial.distros, { name: "Debian", isDefault: false, version: 2 }],
  };
  const pending = Promise.withResolvers<DesktopWslState>();
  const getWslState = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(initial)
    .mockReturnValue(pending.promise);
  vi.stubGlobal("window", { desktopBridge: { getWslState } });
  using _now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const registry = AtomRegistry.make();
  const afterScheduledWork = () =>
    new Promise<void>((resolve) => {
      registry.schedulerAsync.makeDispatcher().scheduleTask(resolve, 0);
    });
  const readSearch = () =>
    new Promise<DesktopWslState>((resolve) => {
      const unsubscribe = registry.subscribe(desktopWslStateAtom, (result) => {
        if (result._tag === "Success" && !result.waiting) {
          unsubscribe();
          resolve(result.value);
        }
      });
    });
  try {
    const closeSearch = registry.mount(desktopWslStateAtom);
    expect(await readSearch()).toEqual(initial);
    closeSearch();
    await afterScheduledWork();

    registry.mount(desktopWslStateAtom);
    expect(AsyncResult.getOrThrow(registry.get(desktopWslStateAtom))).toEqual(initial);
    await afterScheduledWork();
    expect(getWslState).toHaveBeenCalledTimes(1);

    const closeAccess = registry.mount(desktopWslAccessStateAtom);
    const firstVisit = readSearch();
    expect(await firstVisit).toEqual(initial);
    expect(getWslState).toHaveBeenCalledTimes(2);
    closeAccess();
    await afterScheduledWork();

    const closeAccessAgain = registry.mount(desktopWslAccessStateAtom);
    await afterScheduledWork();
    expect(getWslState).toHaveBeenCalledTimes(3);
    expect(AsyncResult.getOrThrow(registry.get(desktopWslStateAtom))).toEqual(initial);
    const refreshed = readSearch();
    pending.resolve(updated);
    expect(await refreshed).toEqual(updated);
    expect(AsyncResult.getOrThrow(registry.get(desktopWslAccessStateAtom))).toEqual(updated);
    closeAccessAgain();
    await afterScheduledWork();

    expect(AsyncResult.getOrThrow(registry.get(desktopWslAccessStateAtom))).toEqual(updated);
    await afterScheduledWork();
    expect(getWslState).toHaveBeenCalledTimes(3);
  } finally {
    registry.dispose();
    vi.unstubAllGlobals();
  }
});
