import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { evaluateWhenNode, resolveEventKeys } from "@t3tools/shared/keybindingMatching";
import { useAtomValue } from "@effect/atom-react";
import {
  ArrowLeftRightIcon,
  Columns2Icon,
  LayersIcon,
  LayoutGridIcon,
  Maximize2Icon,
  MoveHorizontalIcon,
  RulerIcon,
  TerminalSquareIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isKeybindingCaptureTarget } from "../lib/keybindingCapture";
import { isModalDialogOpen } from "../lib/modalDialog";
import { commandLabel } from "../components/settings/KeybindingsSettings.logic";
import { Dialog, DialogPopup } from "../components/ui/dialog";
import { Kbd } from "../components/ui/kbd";
import { ScrollArea } from "../components/ui/scroll-area";
import { isElectron } from "../env";
import {
  formatShortcutKeyLabel,
  formatShortcutLabel,
  resolveShortcutCommand,
} from "../keybindings";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { registerCommands } from "../shortcuts/dispatcher";
import {
  ROUTE_LAYOUT_COMMANDS,
  isLayoutCommand,
  runLayoutCommand,
  useLayoutKeyboardCommands,
} from "./layoutCommands";
import { useLayoutStore } from "./layoutStore";
import {
  setLayoutOverlayMode as setMode,
  useLayoutOverlayStore as useOverlayStore,
} from "./layoutOverlayStore";

/** Holding the layout modifier this long shows the menu (pen WbSUY). */
const HOLD_TO_SHOW_MS = 500;

const ARROW_GLYPHS: Record<string, string> = {
  arrowleft: "←",
  arrowup: "↑",
  arrowright: "→",
  arrowdown: "↓",
};

function keyGlyph(key: string): string {
  return ARROW_GLYPHS[key] ?? formatShortcutKeyLabel(key);
}

/** Every shortcut bound to a command right now, in binding order. */
function shortcutsFor(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
): KeybindingShortcut[] {
  const mac = isMacPlatform(navigator.platform);
  const context = { isMac: mac, isDesktop: isElectron, isWeb: !isElectron };
  return keybindings.flatMap((binding) =>
    binding.command === command && (!binding.whenAst || evaluateWhenNode(binding.whenAst, context))
      ? [binding.shortcut]
      : [],
  );
}

/** The layout modifier: alt+mod, without ctrl or shift. */
function isLayoutChord(shortcut: KeybindingShortcut): boolean {
  return shortcut.altKey && shortcut.modKey && !shortcut.ctrlKey && !shortcut.shiftKey;
}

/** The modifiers of a shortcut as the platform writes them ("⌥⌘", "Ctrl+Alt"). */
function modifierLabel(shortcut: KeybindingShortcut): string {
  const probe = formatShortcutLabel({ ...shortcut, key: "x" }, navigator.platform);
  return probe.slice(0, -1).replace(/\+$/, "");
}

interface MenuRow {
  icon: LucideIcon;
  label: string;
  /**
   * The keys pressed while holding the layout modifier, and what each runs.
   * The menu answers them itself when no alt+cmd chord is bound for them
   * (off macOS, or a keybindings file that predates the alias), so every
   * row works the way it reads.
   */
  keys: ReadonlyArray<{ key: string; command: KeybindingCommand }>;
}

/** The hold menu's three groups (pen WbSUY qlbwh). */
const MENU_GROUPS: ReadonlyArray<{ label: string; rows: ReadonlyArray<MenuRow> }> = [
  {
    label: "Open",
    rows: [
      {
        icon: TerminalSquareIcon,
        label: "Terminal",
        keys: [{ key: "t", command: "terminal.toggle" }],
      },
      {
        icon: Columns2Icon,
        label: "Side pane: diff, files, browser",
        keys: [{ key: "b", command: "rightPanel.toggle" }],
      },
      { icon: LayoutGridIcon, label: "Overview", keys: [{ key: "o", command: "layout.overview" }] },
    ],
  },
  {
    label: "Move around",
    rows: [
      {
        icon: MoveHorizontalIcon,
        label: "Focus the next pane",
        keys: [
          { key: "arrowleft", command: "layout.focusLeft" },
          { key: "arrowright", command: "layout.focusRight" },
        ],
      },
      {
        icon: LayersIcon,
        label: "Next, previous workspace",
        keys: [
          { key: "u", command: "layout.focusWorkspaceDown" },
          { key: "i", command: "layout.focusWorkspaceUp" },
        ],
      },
    ],
  },
  {
    label: "Arrange",
    rows: [
      {
        icon: Maximize2Icon,
        label: "Fill the window",
        keys: [{ key: "f", command: "layout.fill" }],
      },
      {
        icon: RulerIcon,
        label: "Width: ⅓ ½ ⅔",
        keys: [{ key: "r", command: "layout.cycleColumnWidth" }],
      },
      { icon: XIcon, label: "Close the tab", keys: [{ key: "w", command: "tab.close" }] },
    ],
  },
];

/** Keys the held menu answers without a row: up and down move focus too. */
const EXTRA_HELD_KEYS: ReadonlyArray<{ key: string; command: KeybindingCommand }> = [
  { key: "arrowup", command: "layout.focusUp" },
  { key: "arrowdown", command: "layout.focusDown" },
];

/** True while `runHeldCommand` replays a key, which is not the user letting go of the hold. */
let replayingHeldCommand = false;

/**
 * Run a command the held menu offers. Layout commands run directly; others
 * replay the command's own key on the window, the way a chord forwarded
 * from a browser view replays (layoutCommands.ts).
 */
function runHeldCommand(keybindings: ResolvedKeybindingsConfig, command: KeybindingCommand) {
  if (isLayoutCommand(command) && !ROUTE_LAYOUT_COMMANDS.has(command)) {
    runLayoutCommand(command);
    return;
  }
  const mac = isMacPlatform(navigator.platform);
  const shortcut =
    shortcutsFor(keybindings, command).find((candidate) => !isLayoutChord(candidate)) ??
    shortcutsFor(keybindings, command)[0];
  if (!shortcut) return;
  replayingHeldCommand = true;
  try {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: shortcut.key,
        metaKey: shortcut.metaKey || (shortcut.modKey && mac),
        ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
        altKey: shortcut.altKey,
        shiftKey: shortcut.shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  } finally {
    replayingHeldCommand = false;
  }
}

/**
 * Hold alt+cmd (ctrl+alt off macOS) for half a second: the layout menu shows
 * over the focused pane; keep holding and press a letter or arrow, let go and
 * it is gone. Holding cmd alone shows nothing. cmd+/ pins every shortcut.
 * Mounted with the layout host, which also gets the layout keyboard map.
 */
export function LayoutKeyboard() {
  useLayoutKeyboardCommands();
  const mode = useOverlayStore((state) => state.mode);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the held-modifier timer and keyboard subscriptions while the layout host is mounted.
  useEffect(() => {
    const mac = isMacPlatform(navigator.platform);
    const isHeld = (event: KeyboardEvent) =>
      mac
        ? event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
        : event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey;
    let timer: number | null = null;
    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const current = useOverlayStore.getState().mode;
      // The sheet is a modal dialog: it takes Escape itself, and the layout
      // keys yield to it, so only its own chord is answered here, to close it.
      if (current === "sheet") {
        if (
          resolveShortcutCommand(event, appAtomRegistry.get(primaryServerKeybindingsAtom)) ===
          "layout.shortcutSheet"
        ) {
          event.preventDefault();
          event.stopPropagation();
          setMode(null);
        }
        return;
      }
      // A shortcut recorder takes the chord; holding it shows no menu.
      if (isKeybindingCaptureTarget(event.target)) return;
      // The menu's own replay (runHeldCommand) is not a key the user pressed.
      if (replayingHeldCommand) return;
      const modifierOnly = event.key === "Meta" || event.key === "Alt" || event.key === "Control";
      if (modifierOnly && isHeld(event)) {
        if (event.repeat || current !== null || timer !== null) return;
        if (isCommandPaletteOpen() || isModalDialogOpen()) return;
        timer = window.setTimeout(() => {
          timer = null;
          // The overview has its own keys and hint; the menu would cover it.
          if (isCommandPaletteOpen() || isModalDialogOpen()) return;
          if (useLayoutStore.getState().overviewOpen) return;
          setMode("hold");
        }, HOLD_TO_SHOW_MS);
        return;
      }
      // A key pressed with the modifier held runs its command; the menu stays
      // for the next one. Anything else is not a layout key: close it.
      cancel();
      if (current === "hold" && !isHeld(event)) {
        setMode(null);
        return;
      }
      if (current === "hold") answerHeldKey(event);
    };
    // While the menu shows, its keys do what its rows say, bound or not.
    const answerHeldKey = (event: KeyboardEvent) => {
      // By physical key too: macOS types ⌥⌘T as "†".
      const keys = resolveEventKeys(event);
      const entry = [
        ...MENU_GROUPS.flatMap((group) => group.rows.flatMap((row) => row.keys)),
        ...EXTRA_HELD_KEYS,
      ].find((candidate) => keys.has(candidate.key));
      if (!entry) return;
      const keybindings = appAtomRegistry.get(primaryServerKeybindingsAtom);
      const bound = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
      });
      if (bound === entry.command) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      runHeldCommand(keybindings, entry.command);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Meta" && event.key !== "Alt" && event.key !== "Control") return;
      cancel();
      if (useOverlayStore.getState().mode === "hold") setMode(null);
    };
    const reset = () => {
      cancel();
      if (useOverlayStore.getState().mode === "hold") setMode(null);
    };
    // The overview opening (alt+cmd+O from the menu, say) takes the menu down.
    const unsubscribe = useLayoutStore.subscribe((state, previous) => {
      if (state.overviewOpen && !previous.overviewOpen) reset();
    });
    const unregister = registerCommands(
      {},
      {
        capture: true,
        onKeyDown: (event) => {
          onKeyDown(event);
          return event.defaultPrevented;
        },
      },
    );
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", reset);
    return () => {
      unsubscribe();
      cancel();
      unregister();
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", reset);
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Clear the shared shortcut overlay when its host unmounts.
  useEffect(() => () => setMode(null), []);

  return (
    <>
      {mode === "hold" ? <LayoutHoldMenu /> : null}
      <Dialog
        open={mode === "sheet"}
        onOpenChange={(open) => {
          if (!open) setMode(null);
        }}
      >
        <DialogPopup
          aria-label="Keyboard shortcuts"
          showCloseButton={false}
          className="max-w-190"
          // The scroller is the sheet's one tab stop. Tab lands there and stays,
          // rather than wrapping through the focus guards, which a fast Tab slips past.
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            event.preventDefault();
            event.currentTarget
              .querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
              ?.focus();
          }}
        >
          <ScrollArea scrollFade>
            <LayoutShortcutSheet />
          </ScrollArea>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/**
 * Centered over the focused pane, measured once when the menu opens, and
 * kept inside the window: a bottom pane or one half off screen still shows
 * the whole menu.
 */
function useFocusedPanePlacement(menuRef: RefObject<HTMLDivElement | null>): {
  left: number;
  top: number;
} {
  const [placement, setPlacement] = useState(() => ({ left: -9999, top: -9999 }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure the focused pane and menu before placing the shortcut overlay.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const pane = document.querySelector<HTMLElement>(
      "[data-layout-pane-focused='true'][data-layout-pane-id]",
    );
    const rect = pane?.getBoundingClientRect();
    const centerX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const centerY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    const { width, height } = menu.getBoundingClientRect();
    const margin = 8;
    const clamp = (value: number, size: number, room: number) =>
      Math.max(margin, Math.min(value - size / 2, room - size - margin));
    setPlacement({
      left: clamp(centerX, width, window.innerWidth),
      top: clamp(centerY, height, window.innerHeight),
    });
  }, [menuRef]);
  return placement;
}

function LayoutHoldMenu() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const placement = useFocusedPanePlacement(menuRef);
  const mac = isMacPlatform(navigator.platform);
  const holdLabel = mac ? "⌥⌘" : "Ctrl+Alt";
  const sheet = shortcutsFor(keybindings, "layout.shortcutSheet")[0];
  const groups = MENU_GROUPS.map((group) => ({
    label: group.label,
    rows: group.rows.map((row) => {
      // "also ⌘J": the command's own key when it is not the held chord.
      const commands = [...new Set(row.keys.map((entry) => entry.command))];
      const own =
        commands.length === 1
          ? shortcutsFor(keybindings, commands[0]!).findLast((shortcut) => !isLayoutChord(shortcut))
          : undefined;
      return {
        ...row,
        chip: row.keys.map((entry) => keyGlyph(entry.key)).join(" "),
        also: own ? formatShortcutLabel(own, navigator.platform) : null,
      };
    }),
  }));
  const move = shortcutsFor(keybindings, "layout.moveRight")[0];

  return createPortal(
    <div
      role="dialog"
      aria-label="Layout keys"
      data-layout-hold-menu=""
      ref={menuRef}
      className="pointer-events-none fixed z-110 flex max-h-[calc(100vh-1rem)] w-95 max-w-[calc(100vw-1rem)] flex-col gap-0.5 overflow-hidden rounded-pane p-2 surface-popover kbd-in-popover"
      style={placement}
    >
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-2">
        <span className="min-w-0 flex-1 text-label text-strong-foreground">Layout</span>
        <span className="text-meta text-dim-foreground">holding {holdLabel}</span>
      </div>
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <div className="px-2 pt-2 pb-1 text-micro text-dim-foreground">{group.label}</div>
          {group.rows.map((row) => (
            <HoldMenuRow
              key={row.label}
              icon={row.icon}
              keys={row.chip}
              label={row.label}
              also={row.also}
            />
          ))}
          {group.label === "Arrange" && move ? (
            <HoldMenuRow
              icon={ArrowLeftRightIcon}
              keys={`${mac ? "⌃" : "Shift"} + arrows`}
              label="Move the tab"
              also={null}
            />
          ) : null}
        </div>
      ))}
      <div className="px-2 pt-2 pb-1 text-micro text-dim-foreground">
        Let go of {holdLabel} to close
        {sheet ? ` · ${formatShortcutLabel(sheet, navigator.platform)} for every shortcut` : ""}
      </div>
    </div>,
    document.body,
  );
}

function HoldMenuRow(props: {
  icon: LucideIcon;
  keys: string;
  label: string;
  also: string | null;
}) {
  return (
    <div className="flex h-7.5 items-center gap-2.5 rounded-control px-2">
      <span className="flex h-5 min-w-16 shrink-0 items-center justify-center rounded-badge px-1.5 whitespace-nowrap surface-kbd text-micro text-foreground">
        {props.keys}
      </span>
      <props.icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-label text-foreground">{props.label}</span>
      {props.also ? (
        <span className="shrink-0 text-meta text-dim-foreground">also {props.also}</span>
      ) : null}
    </div>
  );
}

/** The layout grid of the full sheet (pen F1nBI, UQkq1). */
const SHEET_LAYOUT_GROUPS: ReadonlyArray<{
  label: string;
  rows: ReadonlyArray<{ label: string; commands: ReadonlyArray<KeybindingCommand> }>;
}> = [
  {
    label: "Focus and move",
    rows: [
      {
        label: "Focus a pane",
        commands: ["layout.focusLeft", "layout.focusUp", "layout.focusRight", "layout.focusDown"],
      },
      {
        label: "Move the pane",
        commands: ["layout.moveLeft", "layout.moveUp", "layout.moveRight", "layout.moveDown"],
      },
      {
        label: "First / last column",
        commands: ["layout.focusFirstColumn", "layout.focusLastColumn"],
      },
    ],
  },
  {
    label: "Columns",
    rows: [
      { label: "Cycle ⅓ ½ ⅔", commands: ["layout.cycleColumnWidth"] },
      { label: "Fill the window", commands: ["layout.fill"] },
      { label: "Center it", commands: ["layout.centerColumn"] },
      { label: "Pull in / push out", commands: ["layout.pullLeft", "layout.pullRight"] },
    ],
  },
  {
    label: "Workspaces",
    rows: [
      { label: "Switch", commands: ["layout.focusWorkspaceDown", "layout.focusWorkspaceUp"] },
      {
        label: "Send the pane there",
        commands: ["layout.moveToWorkspaceDown", "layout.moveToWorkspaceUp"],
      },
      {
        label: "Move the workspace",
        commands: ["layout.moveWorkspaceDown", "layout.moveWorkspaceUp"],
      },
      { label: "Overview", commands: ["layout.overview"] },
    ],
  },
  {
    label: "Tabs and panes",
    rows: [
      { label: "New tab", commands: ["tab.new"] },
      { label: "Close tab", commands: ["tab.close"] },
      { label: "Next / previous tab", commands: ["tab.next", "tab.previous"] },
      { label: "New pane right / below", commands: ["layout.splitRight", "layout.splitDown"] },
    ],
  },
];

/** Areas for every other shortcut, by command prefix. */
const SHEET_AREAS: ReadonlyArray<{ label: string; prefixes: ReadonlyArray<string> }> = [
  { label: "Chat and threads", prefixes: ["chat.", "thread.", "navigation.", "sidebar."] },
  { label: "Composer", prefixes: ["composer.", "modelPicker."] },
  { label: "Panels", prefixes: ["terminal.", "rightPanel.", "threadPanel.", "diff.", "preview."] },
  { label: "Everything else", prefixes: [""] },
];

/** One chord per modifier set, keys after it: ⌥⌘ ← ↑ → ↓. */
function chordsFor(shortcuts: ReadonlyArray<KeybindingShortcut>) {
  const chords: Array<{ modifiers: string; keys: string[] }> = [];
  for (const shortcut of shortcuts) {
    const modifiers = modifierLabel(shortcut);
    const key = keyGlyph(shortcut.key);
    const chord = chords.find((candidate) => candidate.modifiers === modifiers);
    if (chord) {
      if (!chord.keys.includes(key)) chord.keys.push(key);
    } else chords.push({ modifiers, keys: [key] });
  }
  return chords;
}

function LayoutShortcutSheet() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const mac = isMacPlatform(navigator.platform);
  const firstOf = (command: KeybindingCommand) => shortcutsFor(keybindings, command).slice(0, 1);
  const layoutGroups = SHEET_LAYOUT_GROUPS.map((group) => ({
    label: group.label,
    rows: group.rows.flatMap((row) => {
      const shortcuts = row.commands.flatMap(firstOf);
      return shortcuts.length > 0 ? [{ label: row.label, chords: chordsFor(shortcuts) }] : [];
    }),
  }));
  const shown = new Set(
    SHEET_LAYOUT_GROUPS.flatMap((group) => group.rows.flatMap((row) => row.commands)),
  );
  const others = [...new Set(keybindings.map((binding) => binding.command))].filter(
    (command) =>
      !shown.has(command) &&
      !command.startsWith("layout.") &&
      !/\.jump\.\d$/.test(command) &&
      shortcutsFor(keybindings, command).length > 0,
  );
  const areas = SHEET_AREAS.map((area, index) => ({
    label: area.label,
    rows: others
      .filter((command) => {
        const match = SHEET_AREAS.findIndex((candidate) =>
          candidate.prefixes.some((prefix) => command.startsWith(prefix)),
        );
        return match === index;
      })
      .map((command) => ({ label: commandLabel(command), chords: chordsFor(firstOf(command)) })),
  })).filter((area) => area.rows.length > 0);
  const cycle = firstOf("layout.cycleColumnWidth")[0];

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-label text-strong-foreground">
          Keyboard shortcuts
          {cycle ? ` · Layout Mod is ${modifierLabel(cycle)}, same map as niri` : null}
        </h2>
        <div className="flex shrink-0 items-center gap-1.5 text-meta text-dim-foreground">
          <span>Press</span>
          <Kbd>Esc</Kbd>
          <span>to close</span>
        </div>
      </div>
      <ShortcutGrid groups={layoutGroups} />
      <div className="h-px bg-border" />
      <ShortcutGrid groups={areas} />
      {mac ? null : (
        <p className="text-meta text-dim-foreground">
          Off macOS, Ctrl takes the place of ⌘ and Alt+Shift moves focus.
        </p>
      )}
    </div>
  );
}

function ShortcutGrid({
  groups,
}: {
  groups: ReadonlyArray<{
    label: string;
    rows: ReadonlyArray<{ label: string; chords: ReturnType<typeof chordsFor> }>;
  }>;
}) {
  return (
    <div className={cn("grid grid-cols-1 gap-6 sm:grid-cols-2", groups.length > 3 ? "md:grid-cols-4" : "md:grid-cols-3")}>
      {groups.map((group) => (
        <div key={group.label} className="flex min-w-0 flex-col gap-2">
          <div className="text-meta text-dim-foreground">{group.label}</div>
          {group.rows.map((row) => (
            <div key={row.label} className="flex flex-col items-start gap-1">
              <span className="text-meta text-foreground">{row.label}</span>
              <div className="flex max-w-full flex-wrap gap-1">
                {row.chords.map((chord) => (
                  <Kbd key={chord.modifiers}>
                  <span key={chord.modifiers} className="flex items-center gap-1">
                    {chord.modifiers ? <span>{chord.modifiers}</span> : null}
                    {chord.keys.map((key) => (
                      <span key={key}>{key}</span>
                    ))}
                  </span>
                  </Kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
