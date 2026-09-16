import { describe, expect, it } from "vite-plus/test";

import {
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
} from "./composerDispatch.ts";

describe("resolveComposerDispatchMode", () => {
  it("starts an ordinary turn while idle", () => {
    expect(resolveComposerDispatchMode({ running: false, alternateModifier: false })).toBe("auto");
  });

  it("steers by default and reserves Mod+Enter for queueing while running", () => {
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: false })).toBe("steer");
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: true })).toBe("queue");
  });

  it("queues as the alternate action when restarting is the default", () => {
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: false,
        activeTurnDefault: "restart",
      }),
    ).toBe("restart");
    expect(
      resolveComposerDispatchMode({
        running: true,
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
          running: true,
          alternateModifier: false,
          activeTurnDefault,
        }),
      ).toBe(activeTurnDefault);
      expect(
        resolveComposerDispatchMode({
          running: true,
          alternateModifier: true,
          activeTurnDefault,
        }),
      ).toBe(alternateAction);
      expect(
        resolveComposerDispatchMode({
          running: false,
          alternateModifier: false,
          activeTurnDefault,
        }),
      ).toBe("auto");
      expect(
        resolveComposerDispatchMode({ running: false, alternateModifier: true, activeTurnDefault }),
      ).toBe("auto");
    },
  );

  it("names the alternate action so the affordance can be labelled", () => {
    expect(alternateComposerDispatchAction("queue")).toBe("steer");
    expect(alternateComposerDispatchAction("steer")).toBe("queue");
    expect(alternateComposerDispatchAction()).toBe("queue");
  });
});
