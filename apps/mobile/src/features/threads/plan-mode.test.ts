import { describe, expect, it } from "vite-plus/test";

import {
  getBuiltInComposerSlashCommands,
  getPlanModeComposerSlashCommands,
  replaceCurrentComposerTrigger,
  resolveComposerInteractionMode,
  resolveComposerSubmitInteractionMode,
  resolvePlanModeEnabled,
  resolveSlashCommandInteractionMode,
} from "./plan-mode";

describe("mobile plan mode", () => {
  it("defaults off and hides the legacy slash commands", () => {
    const planModeEnabled = resolvePlanModeEnabled(undefined);

    expect(planModeEnabled).toBe(false);
    expect(getBuiltInComposerSlashCommands({ planModeEnabled, query: "" })).toEqual([
      expect.objectContaining({ command: "model" }),
    ]);
  });

  it("shows the legacy slash commands when enabled", () => {
    expect(
      getBuiltInComposerSlashCommands({ planModeEnabled: true, query: "" }).map(
        (item) => item.command,
      ),
    ).toEqual(["model", "plan", "default"]);
  });

  it("matches slash commands case-insensitively in both composers", () => {
    expect(
      getBuiltInComposerSlashCommands({ planModeEnabled: true, query: "PL" }).map(
        (item) => item.command,
      ),
    ).toEqual(["plan"]);
    expect(
      getPlanModeComposerSlashCommands({ planModeEnabled: true, query: "PL" }).map(
        (item) => item.command,
      ),
    ).toEqual(["plan"]);
  });

  it("only applies plan mode slash commands when enabled", () => {
    expect(resolveSlashCommandInteractionMode({ command: "plan", planModeEnabled: false })).toBe(
      null,
    );
    expect(resolveSlashCommandInteractionMode({ command: "default", planModeEnabled: false })).toBe(
      null,
    );
    expect(resolveSlashCommandInteractionMode({ command: "plan", planModeEnabled: true })).toBe(
      "plan",
    );
    expect(resolveSlashCommandInteractionMode({ command: "default", planModeEnabled: true })).toBe(
      "default",
    );
  });

  it("forces outgoing turns to default mode while disabled", () => {
    expect(
      resolveComposerInteractionMode({ interactionMode: "plan", planModeEnabled: false }),
    ).toBe("default");
    expect(resolveComposerInteractionMode({ interactionMode: "plan", planModeEnabled: true })).toBe(
      "plan",
    );
  });

  describe("existing-thread submit parsing", () => {
    it("switches modes for standalone commands while enabled", () => {
      expect(
        resolveComposerSubmitInteractionMode({
          text: " /PLAN ",
          attachmentCount: 0,
          planModeEnabled: true,
        }),
      ).toBe("plan");
      expect(
        resolveComposerSubmitInteractionMode({
          text: "/default",
          attachmentCount: 0,
          planModeEnabled: true,
        }),
      ).toBe("default");
    });

    it("keeps typed commands inert while disabled", () => {
      expect(
        resolveComposerSubmitInteractionMode({
          text: "/plan",
          attachmentCount: 0,
          planModeEnabled: false,
        }),
      ).toBeNull();
    });

    it("sends standalone-looking commands when attachments are present", () => {
      expect(
        resolveComposerSubmitInteractionMode({
          text: "/plan",
          attachmentCount: 1,
          planModeEnabled: true,
        }),
      ).toBeNull();
    });

    it("sends non-standalone text containing a plan command", () => {
      expect(
        resolveComposerSubmitInteractionMode({
          text: "please use /plan for this",
          attachmentCount: 0,
          planModeEnabled: true,
        }),
      ).toBeNull();
      expect(
        resolveComposerSubmitInteractionMode({
          text: "/plan extra",
          attachmentCount: 0,
          planModeEnabled: true,
        }),
      ).toBeNull();
    });
  });

  describe("new-task submit parsing", () => {
    it("shows only plan-mode commands in the popover while enabled", () => {
      expect(
        getPlanModeComposerSlashCommands({ planModeEnabled: true, query: "" }).map(
          (item) => item.command,
        ),
      ).toEqual(["plan", "default"]);
      expect(getPlanModeComposerSlashCommands({ planModeEnabled: false, query: "" })).toEqual([]);
    });

    it("keeps the typed command sendable and forces created threads to default while disabled", () => {
      expect(
        resolveComposerSubmitInteractionMode({
          text: "/plan",
          attachmentCount: 0,
          planModeEnabled: false,
        }),
      ).toBeNull();
      expect(
        resolveComposerInteractionMode({ interactionMode: "plan", planModeEnabled: false }),
      ).toBe("default");
    });
  });

  describe("composer command replacement", () => {
    it("aborts when the current trigger no longer matches the rendered trigger", () => {
      expect(
        replaceCurrentComposerTrigger({
          text: "/default",
          selection: { start: 8, end: 8 },
          expectedKind: "slash-command",
          expectedText: "/plan",
          replacement: "",
          extendSlashCommandToken: true,
        }),
      ).toBeNull();
    });

    it("replaces the full slash-command token when the caret is inside it", () => {
      expect(
        replaceCurrentComposerTrigger({
          text: "/plan do things",
          selection: { start: 3, end: 3 },
          expectedKind: "slash-command",
          expectedText: "/pl",
          replacement: "",
          extendSlashCommandToken: true,
        }),
      ).toEqual({ text: " do things", cursor: 0 });
    });

    it("preserves the slash-command remainder when token extension is disabled", () => {
      expect(
        replaceCurrentComposerTrigger({
          text: "/plan do things",
          selection: { start: 3, end: 3 },
          expectedKind: "slash-command",
          expectedText: "/pl",
          replacement: "",
          extendSlashCommandToken: false,
        }),
      ).toEqual({ text: "an do things", cursor: 0 });
    });

    it("replaces the full path token when the caret is inside it", () => {
      expect(
        replaceCurrentComposerTrigger({
          text: "Open @src/old-file.ts now",
          selection: { start: 13, end: 13 },
          expectedKind: "path",
          expectedText: "@src/old",
          replacement: "[new-file.ts](src/new-file.ts)",
          extendSlashCommandToken: true,
        }),
      ).toEqual({
        text: "Open [new-file.ts](src/new-file.ts) now",
        cursor: 35,
      });
    });
  });
});
