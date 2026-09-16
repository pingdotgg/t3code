import { describe, expect, it } from "vite-plus/test";

import { resolveComposerDispatchMode } from "./composerDispatch";

describe("resolveComposerDispatchMode", () => {
  it("starts an ordinary turn while idle", () => {
    expect(resolveComposerDispatchMode({ phase: "ready", alternateModifier: false })).toBe("auto");
  });

  it("steers by default and reserves Mod+Enter for queueing while running", () => {
    expect(resolveComposerDispatchMode({ phase: "running", alternateModifier: false })).toBe(
      "steer",
    );
    expect(resolveComposerDispatchMode({ phase: "running", alternateModifier: true })).toBe(
      "queue",
    );
  });

  it("queues as the alternate action when restarting is the default", () => {
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        alternateModifier: false,
        activeTurnDefault: "restart",
      }),
    ).toBe("restart");
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        alternateModifier: true,
        activeTurnDefault: "restart",
      }),
    ).toBe("queue");
  });
  it.each([
    ["queue", "steer"],
    ["steer", "queue"],
  ] as const)(
    "uses configured %s behavior only during a running turn",
    (activeTurnDefault, alternateAction) => {
      expect(
        resolveComposerDispatchMode({
          phase: "running",
          alternateModifier: false,
          activeTurnDefault,
        }),
      ).toBe(activeTurnDefault);
      expect(
        resolveComposerDispatchMode({
          phase: "running",
          alternateModifier: true,
          activeTurnDefault,
        }),
      ).toBe(alternateAction);
      expect(
        resolveComposerDispatchMode({
          phase: "ready",
          alternateModifier: false,
          activeTurnDefault,
        }),
      ).toBe("auto");
      expect(
        resolveComposerDispatchMode({ phase: "ready", alternateModifier: true, activeTurnDefault }),
      ).toBe("auto");
    },
  );
});
