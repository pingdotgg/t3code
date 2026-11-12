import { it } from "@effect/vitest";
import type { DesktopWslState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, vi } from "vite-plus/test";

import { desktopWslStateAtom } from "./desktopWslState";

const ubuntuOnly: DesktopWslState = {
  enabled: true,
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

describe("desktopWslState", () => {
  it.effect("revalidates a stale snapshot when the settings screen remounts", () =>
    Effect.gen(function* () {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const getWslState = vi.fn(async () => ubuntuOnly);
      vi.stubGlobal("window", { desktopBridge: { getWslState } });
      // Atom.swr schedules its mount revalidation on the registry scheduler; drain it on demand.
      const scheduled: Array<() => void> = [];
      const registry = AtomRegistry.make({
        scheduleTask: (task) => {
          scheduled.push(task);
          queueMicrotask(runScheduled);
          return () => {};
        },
      });
      function runScheduled() {
        for (let task = scheduled.shift(); task; task = scheduled.shift()) task();
      }

      let unmount = registry.mount(desktopWslStateAtom);
      try {
        yield* AtomRegistry.getResult(registry, desktopWslStateAtom, { suspendOnWaiting: true });
        unmount();
        yield* Effect.yieldNow;

        getWslState.mockResolvedValue(withDebian);
        now.mockReturnValue(1_030_000);

        unmount = registry.mount(desktopWslStateAtom);
        expect(AsyncResult.value(registry.get(desktopWslStateAtom))).toEqual(
          expect.objectContaining({ _tag: "Some", value: ubuntuOnly }),
        );
        runScheduled();
        expect(AsyncResult.isWaiting(registry.get(desktopWslStateAtom))).toBe(true);
        const result = yield* AtomRegistry.getResult(registry, desktopWslStateAtom, {
          suspendOnWaiting: true,
        });
        expect(result).toEqual(withDebian);
        expect(getWslState).toHaveBeenCalledTimes(2);
      } finally {
        unmount();
        registry.dispose();
        now.mockRestore();
        vi.unstubAllGlobals();
      }
    }),
  );
});
