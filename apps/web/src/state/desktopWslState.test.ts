import type { DesktopWslState } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { desktopWslAccessStateAtom, desktopWslStateAtom } from "./desktopWslState";

const ubuntuOnly: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: false,
  distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
  preflightError: null,
};
const withDebian: DesktopWslState = {
  ...ubuntuOnly,
  distros: [...ubuntuOnly.distros, { name: "Debian", isDefault: false, version: 2 }],
};

it("refetches on every Access visit and reuses a fresh result for Search", async () => {
  const pending = Promise.withResolvers<DesktopWslState>();
  const getWslState = vi
    .fn<() => Promise<DesktopWslState>>()
    .mockResolvedValueOnce(ubuntuOnly)
    .mockReturnValueOnce(pending.promise);
  vi.stubGlobal("window", { desktopBridge: { getWslState } });
  using _now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const runTasks = () => {
    for (const task of tasks.splice(0)) task();
  };
  const settled = (atom: typeof desktopWslStateAtom) =>
    new Promise<DesktopWslState>((resolve) => {
      const unsubscribe = registry.subscribe(
        atom,
        (result) => {
          if (result._tag === "Success" && !result.waiting) {
            unsubscribe();
            resolve(result.value);
          }
        },
        { immediate: true },
      );
    });
  try {
    const closeSearch = registry.mount(desktopWslStateAtom);
    expect(await settled(desktopWslStateAtom)).toEqual(ubuntuOnly);
    closeSearch();
    runTasks();

    registry.mount(desktopWslStateAtom)();
    runTasks();
    expect(getWslState).toHaveBeenCalledTimes(1);

    const closeAccess = registry.mount(desktopWslAccessStateAtom);
    runTasks();
    expect(getWslState).toHaveBeenCalledTimes(2);
    expect(AsyncResult.getOrThrow(registry.get(desktopWslAccessStateAtom))).toEqual(ubuntuOnly);
    pending.resolve(withDebian);
    expect(await settled(desktopWslAccessStateAtom)).toEqual(withDebian);
    closeAccess();
  } finally {
    registry.dispose();
    vi.unstubAllGlobals();
  }
});
