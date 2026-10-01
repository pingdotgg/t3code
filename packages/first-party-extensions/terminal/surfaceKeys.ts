import type { ApiDiscovery } from "@t3tools/extension-sdk/capabilities";
import {
  UI_KEYBINDINGS,
  type UiKeybindingChord,
  type UiKeybindingsHost,
} from "@t3tools/extension-sdk/catalogue";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { GlobalCommandDescriptor } from "@t3tools/extension-sdk/environment";
import { isMacPlatform } from "@t3tools/ghostty-terminal/platform";
import { satisfiesSemverRange } from "@t3tools/shared/semver";

import { TERMINAL_FOCUS_WHEN } from "./viewModel.ts";

export interface ShortcutEventLike extends UiKeybindingChord {
  type?: string;
}

/**
 * The Ghostty-level editing intercepts, as plugin-local command ids. Native
 * hard-codes these in the drawer's key handler; here they are
 * `t3.ui/keybindings` commands so user rules can rebind them.
 */
export type TerminalEditingCommandId =
  | "clear"
  | "wordBackward"
  | "wordForward"
  | "lineStart"
  | "lineEnd"
  | "deleteToLineStart";

/** The readline bytes each editing command writes to the PTY. */
export const TERMINAL_EDITING_INPUT: Readonly<Record<TerminalEditingCommandId, string>> = {
  clear: "\u000c",
  wordBackward: "\u001bb",
  wordForward: "\u001bf",
  lineStart: "\u0001",
  lineEnd: "\u0005",
  deleteToLineStart: "\u0015",
};

export function isTerminalEditingCommand(commandId: string): commandId is TerminalEditingCommandId {
  return Object.hasOwn(TERMINAL_EDITING_INPUT, commandId);
}

/** `defaultKeyLogicalOnly` arrived in t3.ui/keybindings 1.2.0; older closed schemas reject it. */
const LOGICAL_DEFAULTS_RANGE = "^1.2.0";

/**
 * Whether both halves of `t3.ui/keybindings` take `defaultKeyLogicalOnly`:
 * the client's own advertisement (its registry validates and matches the
 * defaults) and the API the server selected for this installation (its
 * broker validates the registration). A remote client and server can differ,
 * so an absent or older side on either end means no.
 */
export function hostTakesLogicalDefaults(
  clientVersion: string | undefined,
  discovered: readonly ApiDiscovery[],
): boolean {
  const selected = discovered.find((api) => api.id === UI_KEYBINDINGS && api.selected);
  return (
    clientVersion !== undefined &&
    selected !== undefined &&
    satisfiesSemverRange(clientVersion, LOGICAL_DEFAULTS_RANGE) &&
    satisfiesSemverRange(selected.version, LOGICAL_DEFAULTS_RANGE)
  );
}

/**
 * The editing command set this installation's host can take, and the range to
 * bind `registerCommands` at: defaults ride along, bound at ^1.2.0, only when
 * both sides speak 1.2.0 (see hostTakesLogicalDefaults). A failed discovery
 * takes the old payload on ^1.0.0, which every host accepts.
 */
export async function negotiatedEditingCommands(
  host: {
    readonly keybindings?: Pick<UiKeybindingsHost, "version">;
    discoverApis(context: ViewContext, signal: AbortSignal): Promise<readonly ApiDiscovery[]>;
  },
  context: ViewContext,
  signal: AbortSignal,
  platform?: string,
): Promise<{
  readonly commands: readonly GlobalCommandDescriptor[];
  readonly versionRange: string;
}> {
  let logicalDefaults = false;
  try {
    logicalDefaults = hostTakesLogicalDefaults(
      host.keybindings?.version,
      await host.discoverApis(context, signal),
    );
  } catch {
    // Unknown support takes the payload every host accepts.
  }
  return {
    commands: terminalEditingCommands(platform, logicalDefaults),
    versionRange: logicalDefaults ? LOGICAL_DEFAULTS_RANGE : "^1.0.0",
  };
}

/**
 * Surface-scoped editing command set with the native drawer's defaults for
 * `platform`. Commands native only binds on macOS (line start/end, delete to
 * line start) still register elsewhere, just without a default, so a user
 * rule can bind them. Without `logicalDefaults` the host would match the
 * defaults on the physical key, so they are left off and the local fallback
 * (terminalEditingCommandForKey) applies them on the layout key instead.
 */
export function terminalEditingCommands(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
  logicalDefaults = true,
): readonly GlobalCommandDescriptor[] {
  const mac = isMacPlatform(platform);
  const command = (
    id: TerminalEditingCommandId,
    title: string,
    defaultKey: string | readonly string[] | null,
  ): GlobalCommandDescriptor => ({
    id,
    title,
    scope: "surface",
    // Native matches these on `event.key` alone, so a non-Latin layout's
    // Cmd+л reaches the shell instead of clearing through physical KeyK.
    ...(defaultKey === null || !logicalDefaults ? {} : { defaultKey, defaultKeyLogicalOnly: true }),
    when: TERMINAL_FOCUS_WHEN,
  });
  return [
    command("clear", "Clear terminal screen", mac ? ["ctrl+l", "meta+k"] : "ctrl+l"),
    command(
      "wordBackward",
      "Move cursor back one word",
      mac ? "alt+arrowleft" : ["ctrl+arrowleft", "alt+arrowleft"],
    ),
    command(
      "wordForward",
      "Move cursor forward one word",
      mac ? "alt+arrowright" : ["ctrl+arrowright", "alt+arrowright"],
    ),
    command("lineStart", "Move cursor to line start", mac ? "meta+arrowleft" : null),
    command("lineEnd", "Move cursor to line end", mac ? "meta+arrowright" : null),
    command("deleteToLineStart", "Delete to line start", mac ? "meta+backspace" : null),
  ];
}

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

/**
 * The editing command a keydown triggers under the native default chords —
 * the exact matching the native drawer's intercepts apply.
 */
export function defaultTerminalEditingCommand(
  event: ShortcutEventLike,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): TerminalEditingCommandId | null {
  if (event.type !== undefined && event.type !== "keydown") return null;
  const mac = isMacPlatform(platform);
  const key = normalizeEventKey(event.key);
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = event;

  if (key === "arrowleft" || key === "arrowright") {
    if (shift) return null;
    const left = key === "arrowleft";
    const word = left ? "wordBackward" : "wordForward";
    if (mac) {
      if (alt && !meta && !ctrl) return word;
      if (meta && !alt && !ctrl) return left ? "lineStart" : "lineEnd";
      return null;
    }
    if (ctrl && !meta && !alt) return word;
    if (alt && !meta && !ctrl) return word;
    return null;
  }
  if (key === "backspace") {
    return mac && meta && !ctrl && !alt && !shift ? "deleteToLineStart" : null;
  }
  if (key === "l" && ctrl && !meta && !alt && !shift) return "clear";
  if (mac && key === "k" && meta && !ctrl && !alt && !shift) return "clear";
  return null;
}

/** Where the editing command set's host registration and binding stand. */
export type TerminalEditingBindingState = "pending" | "bound" | "unavailable";

/**
 * What the VT surface does with a keydown the host did not dispatch: apply
 * an editing command locally, `"hold"` the key (consume it, write nothing),
 * or null to leave it to Ghostty's encoder.
 */
export type TerminalEditingKeyAction = TerminalEditingCommandId | "hold" | null;

/**
 * The local fallback for the editing commands. The host's capture dispatcher
 * runs first and consumes any chord it dispatches, so reaching here means it
 * could not — typically because the set's binding is still pending. The
 * fallback resolves through the same effective table the dispatcher uses:
 * a user rule naming one of this plugin's editing commands applies that
 * command (a Ctrl+U rebound to clear clears, never Ghostty's 0x15), any
 * other claim leaves the key to the encoder so a conflict never swallows
 * typing, and the native-matching defaults apply only on a miss. Without
 * the host resolver the user's rules are unreadable, so default chords are
 * held until the binding settles rather than run over a possible rebind.
 */
export function terminalEditingCommandForKey(
  event: ShortcutEventLike,
  keybindings: Pick<UiKeybindingsHost, "resolveTerminalFocusKey"> | undefined,
  options: { readonly pluginId: string; readonly binding: TerminalEditingBindingState },
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): TerminalEditingKeyAction {
  if (event.type !== undefined && event.type !== "keydown") return null;
  if (keybindings !== undefined) {
    const resolved = keybindings.resolveTerminalFocusKey(event);
    if (resolved === null) return defaultTerminalEditingCommand(event, platform);
    const prefix = `ext.${options.pluginId}.`;
    const own = resolved.startsWith(prefix) ? resolved.slice(prefix.length) : null;
    return own !== null && isTerminalEditingCommand(own) ? own : null;
  }
  const command = defaultTerminalEditingCommand(event, platform);
  if (command === null) return null;
  return options.binding === "pending" ? "hold" : command;
}

/**
 * The VT surface's `beforeKey` for the editing commands: applies the local
 * fallback's action through `send` and returns whether Ghostty should still
 * encode the key. Returning false also makes the surface swallow the key's
 * release, so a held or applied chord never leaks a Kitty release event.
 */
export function terminalEditingBeforeKey(
  event: ShortcutEventLike & { preventDefault(): void; stopPropagation(): void },
  keybindings: Pick<UiKeybindingsHost, "resolveTerminalFocusKey"> | undefined,
  options: { readonly pluginId: string; readonly binding: TerminalEditingBindingState },
  send: (data: string) => void,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  const action = terminalEditingCommandForKey(event, keybindings, options, platform);
  if (action === null) return true;
  event.preventDefault();
  event.stopPropagation();
  if (action !== "hold") send(TERMINAL_EDITING_INPUT[action]);
  return false;
}
