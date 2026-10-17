import type { ServerConfigStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createKeybindingsUpdateToastController,
  KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS,
} from "./KeybindingsUpdateToast.logic";

function keybindingsEvent(
  overrides: Partial<Extract<ServerConfigStreamEvent, { type: "keybindingsUpdated" }>> = {},
): Extract<ServerConfigStreamEvent, { type: "keybindingsUpdated" }> {
  return {
    version: 1,
    type: "keybindingsUpdated",
    payload: {
      keybindings: [],
      issues: [],
    },
    ...overrides,
  };
}

describe("keybindings update toast policy", () => {
  it("coalesces repeated successful reload notifications during the cooldown", () => {
    let now = 1_000;
    const controller = createKeybindingsUpdateToastController({
      now: () => now,
    });

    expect(controller.handle(keybindingsEvent())).toEqual({ _tag: "Success" });

    now += KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS - 1;
    expect(controller.handle(keybindingsEvent())).toBeNull();

    now += 1;
    expect(controller.handle(keybindingsEvent())).toEqual({ _tag: "Success" });
  });

  it("surfaces keybinding configuration issues", () => {
    const controller = createKeybindingsUpdateToastController({});

    expect(
      controller.handle(
        keybindingsEvent({
          payload: {
            keybindings: [],
            issues: [
              {
                kind: "keybindings.malformed-config",
                message: "Expected JSON array",
              },
            ],
          },
        }),
      ),
    ).toEqual({
      _tag: "InvalidConfiguration",
      message: "Expected JSON array",
    });
  });

  it.each(["snapshot", "seed"])("reports unchanged-bindings recovery after %s", (initial) => {
    const controller = createKeybindingsUpdateToastController({});
    const malformed = {
      kind: "keybindings.malformed-config",
      message: "Expected JSON array",
    } as const;
    const delta = (
      changes: Extract<ServerConfigStreamEvent, { type: "configDelta" }>["changes"],
    ): ServerConfigStreamEvent => ({
      version: 1,
      type: "configDelta",
      configVersion: "v2",
      changes,
      removed: [],
      providerChanges: [],
    });
    if (initial === "seed") {
      controller.seed([malformed]);
      controller.seed([]);
    } else
      controller.handle({ version: 1, type: "snapshot", config: { issues: [malformed] } as never });
    expect(controller.handle(delta({ issues: [malformed] }))).toBeNull();
    expect(controller.handle(delta({ issues: [] }))).toEqual({ _tag: "Success" });
    expect(controller.handle(delta({ issues: [] }))).toBeNull();
    expect(controller.handle(delta({ issues: [malformed] }))).toEqual({
      _tag: "InvalidConfiguration",
      message: malformed.message,
    });
    expect(controller.handle(delta({ cwd: "/repo" }))).toBeNull();
    expect(createKeybindingsUpdateToastController({}).handle(delta({ keybindings: [] }))).toEqual({
      _tag: "Success",
    });
  });

  it("ignores unrelated server config notifications", () => {
    const controller = createKeybindingsUpdateToastController({});

    expect(
      controller.handle({
        version: 1,
        type: "settingsUpdated",
        payload: { settings: {} as never },
      }),
    ).toBeNull();
  });
});
