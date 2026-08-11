import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  open: false,
  toggleVoicePanel: vi.fn(),
  keybindings: [
    {
      command: "voice.toggle",
      shortcut: {
        key: "v",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: true,
        modKey: true,
      },
    },
  ] satisfies ResolvedKeybindingsConfig,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.keybindings,
}));

vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));

vi.mock("../../voice/voicePanelStore", () => ({
  useVoicePanelStore: (selector: (state: typeof testState) => unknown) => selector(testState),
}));

import { SidebarMenuButton } from "../ui/sidebar";
import { VoicePanelSidebarMenuItem } from "./VoicePanelSidebarMenuItem";

beforeEach(() => {
  testState.open = false;
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("VoicePanelSidebarMenuItem", () => {
  it("shows its custom shortcut and toggles the shared panel before closing its sidebar", () => {
    const onSelect = vi.fn();
    const item = VoicePanelSidebarMenuItem({ onSelect });
    if (!isValidElement<Record<string, unknown>>(item)) {
      throw new Error("Expected a sidebar menu item.");
    }
    const button = item.props.children;
    if (!isValidElement<Record<string, unknown>>(button) || button.type !== SidebarMenuButton) {
      throw new Error("Expected a sidebar menu button.");
    }

    expect(button.props["aria-expanded"]).toBe(false);
    expect(button.props["aria-pressed"]).toBe(false);
    expect(button.props["aria-controls"]).toBe("voice-supervisor-panel");
    expect(button.props.tooltip).toBe("Open voice supervisor (⌥⌘V)");
    expect(JSON.stringify(button.props.children)).toContain("Voice");
    expect(JSON.stringify(button.props.children)).toContain("⌥⌘V");

    const onClick = button.props.onClick;
    if (typeof onClick !== "function") throw new Error("Expected an item click handler.");
    onClick();
    expect(testState.toggleVoicePanel).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(
      testState.toggleVoicePanel.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    ).toBeLessThan(onSelect.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });

  it("reports the shared panel as active when it is open", () => {
    testState.open = true;
    const item = VoicePanelSidebarMenuItem({});
    if (!isValidElement<Record<string, unknown>>(item)) {
      throw new Error("Expected a sidebar menu item.");
    }
    const button = item.props.children;
    if (!isValidElement<Record<string, unknown>>(button)) {
      throw new Error("Expected a sidebar menu button.");
    }

    expect(button.props.isActive).toBe(true);
    expect(button.props["aria-expanded"]).toBe(true);
    expect(button.props["aria-pressed"]).toBe(true);
    expect(button.props["aria-label"]).toBe("Hide voice supervisor (⌥⌘V)");
  });
});
