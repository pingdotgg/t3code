/**
 * Host bridge for the client-local half of `t3.ui/keybindings` (since 1.1.0).
 * `installedController` invokes the returned factory once per installed
 * client, so each `ClientHost.keybindings` binds that installation's grants
 * and lifetime. Resolution is the keydown dispatcher's own
 * `resolveShortcutCommand` over the same keymap atom and published `when`
 * context, so a plugin that owns terminal focus learns exactly which command
 * the dispatcher resolved (and yielded to it) for a chord — synchronously,
 * with no server round-trip.
 */
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  UI_KEYBINDINGS,
  UI_KEYBINDINGS_VERSION,
  type UiKeybindingsHost,
} from "@t3tools/extension-sdk/catalogue";

import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  type ShortcutMatchContext,
} from "~/keybindings";
import { readShortcutContext } from "~/lib/shortcutContext";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "~/state/server";

export interface KeybindingsHostBinding {
  readonly grants: { readonly capabilities: readonly string[] };
  /** Aborting retires the capability; later calls resolve nothing. */
  readonly lifetime: AbortSignal;
}

/** Seams the tests substitute; production defaults read the live stores. */
export interface KeybindingsHostBridgeDeps {
  readonly keybindings: () => ResolvedKeybindingsConfig;
  readonly shortcutContext: () => Partial<ShortcutMatchContext>;
  readonly platform?: string;
}

export function createKeybindingsHostBridge(
  overrides: Partial<KeybindingsHostBridgeDeps> = {},
): (binding: KeybindingsHostBinding) => UiKeybindingsHost | undefined {
  const deps: KeybindingsHostBridgeDeps = {
    keybindings: () => appAtomRegistry.get(primaryServerKeybindingsAtom),
    shortcutContext: readShortcutContext,
    ...overrides,
  };
  // The dispatcher's live context with terminal focus forced: an extension
  // terminal owns focus, but `terminalOpen` still tracks the native drawer.
  // Labels and dispatch both read it, so a label never names a chord the
  // dispatcher would refuse.
  const terminalFocusOptions = () => ({
    context: { ...deps.shortcutContext(), terminalFocus: true },
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  });
  return (binding) => {
    if (!binding.grants.capabilities.includes(UI_KEYBINDINGS)) return undefined;
    return {
      id: UI_KEYBINDINGS,
      version: UI_KEYBINDINGS_VERSION,
      resolveTerminalFocusKey(chord) {
        if (binding.lifetime.aborted) return null;
        // Plugins call this from a keydown handler; a malformed chord or
        // keymap answers "nothing claims it" rather than throwing into them.
        try {
          return resolveShortcutCommand(chord, deps.keybindings(), terminalFocusOptions());
        } catch {
          return null;
        }
      },
      terminalFocusShortcutLabel(command) {
        if (binding.lifetime.aborted) return null;
        try {
          const keybindings = deps.keybindings();
          // Only a command some rule names can have a label.
          const known = keybindings.find((rule) => rule.command === command)?.command;
          if (known === undefined) return null;
          return shortcutLabelForCommand(keybindings, known, terminalFocusOptions());
        } catch {
          return null;
        }
      },
    };
  };
}
