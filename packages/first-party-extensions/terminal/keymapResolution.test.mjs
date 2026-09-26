/**
 * Chord-resolution regressions against the REAL host keymap machinery: the
 * `t3.ui/keybindings@1.1.0` client bridge and the dispatcher's
 * `resolveShortcutCommand`, bundled from the web source and fed real
 * compiled rules from `@t3tools/shared/keybindings`. The bridge answers
 * with the same resolver ChatView's window capture runs before the
 * surface's own capture handler sees an event, so these tests pin what the
 * host actually answers — not a hand-rolled mock of it.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { terminalChordAction } from "./viewModel.ts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { hostKeybindings, loadHostKeymap, userRule } from "./fixtures/hostKeymap.mjs";

let keymap;

NodeTest.before(async () => {
  keymap = await loadHostKeymap();
});

// A macOS mod chord, as the surface's capture handler receives it.
const macEvent = (key, extra = {}) => ({
  key,
  code: `Key${key.toUpperCase()}`,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

/** What the dispatcher resolves for a focused terminal (terminalFocus true). */
const dispatcherResolves = (event, rules) =>
  keymap.resolveShortcutCommand(event, rules, {
    platform: "MacIntel",
    context: { terminalFocus: true },
  });

const macHost = (rules) => hostKeybindings(keymap, () => rules, { platform: "MacIntel" });

NodeTest.describe(
  "chord resolution through the host resolver (host-keybinding-resolve-api)",
  () => {
    NodeTest.test("the capability answers exactly what the dispatcher resolves", () => {
      const rules = [
        ...DEFAULT_RESOLVED_KEYBINDINGS,
        userRule("terminal.close", "mod+j"),
        userRule("terminal.split", "mod+e"),
      ];
      const host = macHost(rules);
      for (const event of [
        macEvent("d"),
        macEvent("D", { shiftKey: true }),
        macEvent("n"),
        macEvent("w"),
        macEvent("j"),
        macEvent("e"),
        macEvent("t"),
        macEvent("k"),
        macEvent("x", { metaKey: false }),
      ]) {
        NodeAssert.equal(host.resolveTerminalFocusKey(event), dispatcherResolves(event, rules));
      }
    });

    NodeTest.test("the native defaults map to their panel actions", () => {
      const host = macHost(DEFAULT_RESOLVED_KEYBINDINGS);
      NodeAssert.equal(terminalChordAction(macEvent("d"), host, true), "split");
      NodeAssert.equal(
        terminalChordAction(macEvent("D", { shiftKey: true }), host, true),
        "splitVertical",
      );
      NodeAssert.equal(terminalChordAction(macEvent("n"), host, true), "new");
      NodeAssert.equal(terminalChordAction(macEvent("w"), host, true), "close");
      // mod+j resolves terminal.toggle, which the host dispatches itself.
      NodeAssert.equal(host.resolveTerminalFocusKey(macEvent("j")), "terminal.toggle");
      NodeAssert.equal(terminalChordAction(macEvent("j"), host, true), null);
      // Unbound chords and typing are the shell's.
      NodeAssert.equal(terminalChordAction(macEvent("t"), host, true), null);
      NodeAssert.equal(terminalChordAction(macEvent("x", { metaKey: false }), host, true), null);
    });

    NodeTest.test("a displaced default dispatches the remapped command", () => {
      const rules = [
        ...DEFAULT_RESOLVED_KEYBINDINGS,
        userRule("terminal.close", "mod+d"),
        userRule("terminal.close", "mod+j"),
      ];
      const host = macHost(rules);
      NodeAssert.equal(
        keymap.isExtensionClaimedTerminalCommand("terminal.close", "extension"),
        true,
      );
      NodeAssert.equal(terminalChordAction(macEvent("d"), host, true), "close");
      NodeAssert.equal(terminalChordAction(macEvent("j"), host, true), "close");
    });

    NodeTest.test("a remap onto a chord with no registered default applies", () => {
      // A mod+e → terminal.split remap: listConflicts reports no rows for
      // mod+e, so only the resolved keymap can see it.
      const host = macHost([...DEFAULT_RESOLVED_KEYBINDINGS, userRule("terminal.split", "mod+e")]);
      NodeAssert.equal(terminalChordAction(macEvent("e"), host, true), "split");
    });

    NodeTest.test("a terminalFocus-guarded remap applies", () => {
      // Invisible to listConflicts, which evaluates rules with terminalFocus
      // false and reports the !terminalFocus sibling (diff.toggle).
      const host = macHost([
        ...DEFAULT_RESOLVED_KEYBINDINGS,
        userRule("terminal.close", "mod+d", "terminalFocus"),
      ]);
      NodeAssert.equal(terminalChordAction(macEvent("d"), host, true), "close");
    });

    NodeTest.test("a remap away from a terminal command releases the chord", () => {
      // mod+w rebound to a non-terminal command: the host dispatches it
      // itself, so the surface must not also close.
      const host = macHost([...DEFAULT_RESOLVED_KEYBINDINGS, userRule("diff.toggle", "mod+w")]);
      NodeAssert.equal(host.resolveTerminalFocusKey(macEvent("w")), "diff.toggle");
      NodeAssert.equal(terminalChordAction(macEvent("w"), host, true), null);
    });

    NodeTest.test("the dispatcher's published when-context is honored", () => {
      // A rule gated on context only the mounted dispatcher knows.
      const rules = [
        ...DEFAULT_RESOLVED_KEYBINDINGS,
        userRule("terminal.split", "mod+e", "terminalFocus && terminalOpen"),
      ];
      const host = macHost(rules);
      NodeAssert.equal(terminalChordAction(macEvent("e"), host, true), null);
      const unpublish = keymap.publishShortcutContext(() => ({
        terminalFocus: false,
        terminalOpen: true,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      }));
      try {
        // terminalFocus is forced true; terminalOpen comes from the dispatcher.
        NodeAssert.equal(terminalChordAction(macEvent("e"), host, true), "split");
      } finally {
        unpublish();
      }
      NodeAssert.equal(terminalChordAction(macEvent("e"), host, true), null);
    });

    NodeTest.test("grant and lifetime gate the capability", () => {
      const bridge = keymap.createKeybindingsHostBridge({
        keybindings: () => DEFAULT_RESOLVED_KEYBINDINGS,
        shortcutContext: () => ({}),
        platform: "MacIntel",
      });
      const lifetime = new AbortController();
      NodeAssert.equal(
        bridge({ grants: { capabilities: [] }, lifetime: lifetime.signal }),
        undefined,
      );
      const host = bridge({
        grants: { capabilities: ["t3.ui/keybindings"] },
        lifetime: lifetime.signal,
      });
      NodeAssert.equal(host.id, "t3.ui/keybindings");
      NodeAssert.equal(host.version, "1.1.0");
      NodeAssert.equal(host.resolveTerminalFocusKey(macEvent("d")), "terminal.split");
      lifetime.abort();
      NodeAssert.equal(host.resolveTerminalFocusKey(macEvent("d")), null);
    });

    NodeTest.test("without the capability only the shipped default chords apply", () => {
      NodeAssert.equal(terminalChordAction(macEvent("d"), undefined, true), "split");
      NodeAssert.equal(terminalChordAction(macEvent("w"), undefined, true), "close");
      NodeAssert.equal(terminalChordAction(macEvent("e"), undefined, true), null);
      NodeAssert.equal(terminalChordAction(macEvent("j"), undefined, true), null);
    });

    NodeTest.test("the contract is additive: 1.1.0 keeps every 1.0.0 method", async () => {
      const catalogue = await import("@t3tools/extension-sdk/catalogue");
      NodeAssert.equal(catalogue.uiKeybindingsApi.definition.version, "1.1.0");
      NodeAssert.equal(catalogue.UI_KEYBINDINGS_VERSION, "1.1.0");
      const names = catalogue.uiKeybindingsApi.definition.methods
        .map((method) => method.name)
        .sort();
      NodeAssert.deepEqual(names, [
        "getCapabilities",
        "listConflicts",
        "registerCommands",
        "unregisterCommands",
      ]);
    });
  },
);
