import type { DesktopCliCommandState } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";

import { desktopCliCommandStateAtom } from "./desktopCliCommand";

const getState = vi.fn<() => Promise<DesktopCliCommandState>>();
vi.stubGlobal("window", { desktopBridge: { cliCommand: { getState } } });

describe("desktopCliCommandStateAtom", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("reloads stale state when Settings mounts it again", async () => {
    getState.mockResolvedValue({
      supported: true,
      installedPath: null,
      onPath: false,
      launcherPath: null,
    });
    using now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const registry = AtomRegistry.make();

    const unmountFirst = registry.mount(desktopCliCommandStateAtom);
    await vi.waitFor(() => {
      const result = registry.get(desktopCliCommandStateAtom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    unmountFirst();
    await vi.waitFor(() => expect(registry.getNodes().size).toBe(1));

    now.mockReturnValue(1_060_000);
    const unmountSecond = registry.mount(desktopCliCommandStateAtom);
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    unmountSecond();
    registry.dispose();
  });
});
