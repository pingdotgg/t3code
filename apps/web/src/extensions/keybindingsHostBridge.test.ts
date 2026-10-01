import { describe, expect, it } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";
import type { KeybindingRule, ResolvedKeybindingsConfig } from "@t3tools/contracts";

import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  type ShortcutMatchContext,
} from "~/keybindings";
import { publishShortcutContext } from "~/lib/shortcutContext";

import { createKeybindingsHostBridge } from "./keybindingsHostBridge";

const chord = (key: string, extra: { shiftKey?: boolean } = {}) => ({
  key,
  code: `Key${key.toUpperCase()}`,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: extra.shiftKey ?? false,
});

const withUserRules = (...rules: KeybindingRule[]): ResolvedKeybindingsConfig => [
  ...DEFAULT_RESOLVED_KEYBINDINGS,
  ...compileResolvedKeybindingsConfig(rules),
];

function bind(keybindings: ResolvedKeybindingsConfig, capabilities = ["t3.ui/keybindings"]) {
  const lifetime = new AbortController();
  const host = createKeybindingsHostBridge({
    keybindings: () => keybindings,
    platform: "MacIntel",
  })({
    grants: { capabilities },
    lifetime: lifetime.signal,
  });
  return { host, lifetime };
}

describe("t3.ui/keybindings@1.1.0 client capability", () => {
  it("resolves exactly what the dispatcher resolves under terminal focus", () => {
    const keybindings = withUserRules(
      { key: "mod+e", command: "terminal.split" },
      { key: "mod+d", command: "terminal.close", when: "terminalFocus" },
      { key: "mod+shift+j", command: "terminal.splitVertical" },
    );
    const { host } = bind(keybindings);
    const context: Partial<ShortcutMatchContext> = { terminalFocus: true };
    for (const event of [chord("d"), chord("e"), chord("j"), chord("J", { shiftKey: true })]) {
      expect(host?.resolveTerminalFocusKey(event)).toBe(
        resolveShortcutCommand(event, keybindings, { platform: "MacIntel", context }),
      );
    }
    expect(host?.resolveTerminalFocusKey(chord("d"))).toBe("terminal.close");
    expect(host?.resolveTerminalFocusKey(chord("t"))).toBeNull();
  });

  it("labels a command's effective terminal shortcut the way native terminal chrome does", () => {
    const defaults = bind(DEFAULT_RESOLVED_KEYBINDINGS).host;
    const native = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "terminal.close", {
      platform: "MacIntel",
      context: { terminalFocus: true },
    });
    expect(native).not.toBeNull();
    expect(defaults?.terminalFocusShortcutLabel?.("terminal.close")).toBe(native);

    const remapped = bind(
      withUserRules({ key: "mod+shift+x", command: "terminal.close", when: "terminalFocus" }),
    );
    expect(remapped.host?.terminalFocusShortcutLabel?.("terminal.close")).toBe("⇧⌘X");
    expect(remapped.host?.terminalFocusShortcutLabel?.("plugin.unbound")).toBeNull();
    remapped.lifetime.abort();
    expect(remapped.host?.terminalFocusShortcutLabel?.("terminal.close")).toBeNull();
  });

  it("labels only the shortcut the dispatcher would run in its published context", () => {
    const { host } = bind(
      withUserRules({ key: "mod+shift+x", command: "terminal.close", when: "terminalOpen" }),
    );
    const shiftX = chord("X", { shiftKey: true });
    for (const terminalOpen of [false, true]) {
      const unpublish = publishShortcutContext(() => ({
        terminalFocus: false,
        terminalOpen,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      }));
      try {
        const dispatched = host?.resolveTerminalFocusKey(shiftX);
        const label = host?.terminalFocusShortcutLabel?.("terminal.close");
        // An extension terminal owns focus while the native drawer may be closed.
        expect(dispatched).toBe(terminalOpen ? "terminal.close" : null);
        expect(label === "⇧⌘X").toBe(dispatched === "terminal.close");
        expect(label).toBe(
          shortcutLabelForCommand(
            withUserRules({ key: "mod+shift+x", command: "terminal.close", when: "terminalOpen" }),
            "terminal.close",
            { platform: "MacIntel", context: { terminalFocus: true, terminalOpen } },
          ),
        );
      } finally {
        unpublish();
      }
    }
  });

  it("evaluates the dispatcher's published context with terminal focus forced", () => {
    const { host } = bind(
      withUserRules({ key: "mod+e", command: "terminal.split", when: "terminalOpen" }),
    );
    expect(host?.resolveTerminalFocusKey(chord("e"))).toBeNull();
    const unpublish = publishShortcutContext(() => ({
      terminalFocus: false,
      terminalOpen: true,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    }));
    try {
      expect(host?.resolveTerminalFocusKey(chord("e"))).toBe("terminal.split");
      // terminalFocus is forced true even though the dispatcher's focus is elsewhere.
      expect(host?.resolveTerminalFocusKey(chord("d"))).toBe("terminal.split");
    } finally {
      unpublish();
    }
    expect(host?.resolveTerminalFocusKey(chord("e"))).toBeNull();
  });

  it("an earlier reader's unpublish leaves a newer reader in place", () => {
    const { host } = bind(
      withUserRules({ key: "mod+e", command: "terminal.split", when: "terminalOpen" }),
    );
    const read = (terminalOpen: boolean) => () => ({
      terminalFocus: true,
      terminalOpen,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    });
    const first = publishShortcutContext(read(false));
    const second = publishShortcutContext(read(true));
    first();
    expect(host?.resolveTerminalFocusKey(chord("e"))).toBe("terminal.split");
    second();
  });

  it("answers null instead of throwing through the caller on a malformed chord or keymap", () => {
    const { host } = bind(DEFAULT_RESOLVED_KEYBINDINGS);
    const malformed = { ...chord("d"), key: undefined as unknown as string };
    expect(host?.resolveTerminalFocusKey(malformed)).toBeNull();
    const broken = createKeybindingsHostBridge({
      keybindings: () => {
        throw new Error("keymap unavailable");
      },
      platform: "MacIntel",
    })({ grants: { capabilities: ["t3.ui/keybindings"] }, lifetime: new AbortController().signal });
    expect(broken?.resolveTerminalFocusKey(chord("d"))).toBeNull();
  });

  it("is absent without the grant and resolves nothing after its lifetime", () => {
    expect(bind(DEFAULT_RESOLVED_KEYBINDINGS, []).host).toBeUndefined();
    const { host, lifetime } = bind(DEFAULT_RESOLVED_KEYBINDINGS);
    expect(host).toMatchObject({ id: "t3.ui/keybindings", version: "1.2.0" });
    expect(host?.resolveTerminalFocusKey(chord("d"))).toBe("terminal.split");
    lifetime.abort();
    expect(host?.resolveTerminalFocusKey(chord("d"))).toBeNull();
  });
});
