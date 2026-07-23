import { describe, expect, it } from "vite-plus/test";

import {
  resolveChatNewShortcutBehavior,
  shouldHandleChatRouteShortcut,
} from "./chatRouteShortcuts";

describe("shouldHandleChatRouteShortcut", () => {
  it("lets chat.new refresh an already-open command palette", () => {
    expect(shouldHandleChatRouteShortcut({ command: "chat.new", commandPaletteOpen: true })).toBe(
      true,
    );
  });

  it("continues to suppress unrelated chat shortcuts while the palette is open", () => {
    expect(
      shouldHandleChatRouteShortcut({ command: "chat.newLocal", commandPaletteOpen: true }),
    ).toBe(false);
    expect(shouldHandleChatRouteShortcut({ command: null, commandPaletteOpen: true })).toBe(false);
  });

  it("handles shortcuts normally while the palette is closed", () => {
    expect(
      shouldHandleChatRouteShortcut({ command: "chat.newLocal", commandPaletteOpen: false }),
    ).toBe(true);
  });
});

describe("resolveChatNewShortcutBehavior", () => {
  it("opens the project picker when Sidebar V2 has multiple projects", () => {
    expect(
      resolveChatNewShortcutBehavior({
        sidebarV2Enabled: true,
        projectCount: 2,
        commandPaletteOpen: true,
      }),
    ).toBe("open-project-picker");
  });

  it("opens the picker empty state when Sidebar V2 has no projects", () => {
    expect(
      resolveChatNewShortcutBehavior({
        sidebarV2Enabled: true,
        projectCount: 0,
        commandPaletteOpen: false,
      }),
    ).toBe("open-project-picker");
  });

  it("creates immediately for Sidebar V1 and single-project setups", () => {
    expect(
      resolveChatNewShortcutBehavior({
        sidebarV2Enabled: false,
        projectCount: 2,
        commandPaletteOpen: false,
      }),
    ).toBe("create-immediately");
    expect(
      resolveChatNewShortcutBehavior({
        sidebarV2Enabled: true,
        projectCount: 1,
        commandPaletteOpen: false,
      }),
    ).toBe("create-immediately");
  });

  it("dismisses an open palette before immediate creation", () => {
    expect(
      resolveChatNewShortcutBehavior({
        sidebarV2Enabled: false,
        projectCount: 1,
        commandPaletteOpen: true,
      }),
    ).toBe("dismiss-and-create");
  });
});
