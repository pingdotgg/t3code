import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createThreadInsightsRefreshAtom } from "./threadInsightsRefresh";

function setup() {
  const revisions = Atom.make<ReadonlyMap<string, string | undefined>>(
    new Map([["local:root", "0"]]),
  );
  const refresh = vi.fn();
  const atom = createThreadInsightsRefreshAtom(revisions, refresh);
  const registry = AtomRegistry.make();
  return { revisions, refresh, atom, registry };
}

describe("thread insights refresh", () => {
  it("shares one refresh deadline across readers without starving on continuous updates", () => {
    vi.useFakeTimers();
    try {
      const { revisions, refresh, atom, registry } = setup();
      const unmountRow = registry.mount(atom);
      const unmountPanel = registry.mount(atom);
      expect(refresh).not.toHaveBeenCalled();
      registry.set(revisions, new Map([["local:root", "1"]]));
      vi.advanceTimersByTime(500);
      registry.set(revisions, new Map([["local:root", "2"]]));
      vi.advanceTimersByTime(500);
      expect(refresh).toHaveBeenCalledTimes(1);
      unmountRow();
      registry.set(revisions, new Map([["local:root", "3"]]));
      vi.advanceTimersByTime(1_000);
      expect(refresh).toHaveBeenCalledTimes(2);
      registry.set(revisions, new Map([["local:root", "4"]]));
      unmountPanel();
      vi.runAllTimers();
      expect(refresh).toHaveBeenCalledTimes(2);
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks newly loaded subagents without refetching just because an answer arrived", () => {
    vi.useFakeTimers();
    try {
      const { revisions, refresh, atom, registry } = setup();
      const unmount = registry.mount(atom);
      registry.set(
        revisions,
        new Map([
          ["local:root", "0"],
          ["remote:child", "0"],
        ]),
      );
      vi.runAllTimers();
      expect(refresh).not.toHaveBeenCalled();
      registry.set(
        revisions,
        new Map([
          ["local:root", "0"],
          ["remote:child", "1"],
        ]),
      );
      vi.advanceTimersByTime(1_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      registry.set(
        revisions,
        new Map([
          ["local:root", "0"],
          ["remote:child", undefined],
        ]),
      );
      vi.advanceTimersByTime(1_000);
      expect(refresh).toHaveBeenCalledTimes(2);
      unmount();
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
