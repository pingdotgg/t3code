import { describe, expect, it } from "vite-plus/test";

import { resolveComposerDispatchMode } from "./composerDispatch";

describe("resolveComposerDispatchMode", () => {
  it("starts an ordinary turn while idle", () => {
    expect(resolveComposerDispatchMode({ phase: "ready", queueModifier: false })).toBe("auto");
  });

  it("steers by default and reserves Mod+Enter for queueing while running", () => {
    expect(resolveComposerDispatchMode({ phase: "running", queueModifier: false })).toBe("steer");
    expect(resolveComposerDispatchMode({ phase: "running", queueModifier: true })).toBe("queue");
  });

  it("accepts a configured default without changing the queue shortcut", () => {
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        queueModifier: false,
        activeTurnDefault: "restart",
      }),
    ).toBe("restart");
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        queueModifier: true,
        activeTurnDefault: "restart",
      }),
    ).toBe("queue");
  });
});
