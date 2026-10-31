import {
  ChevronDown,
  FileDiff,
  Files,
  Globe2,
  MessagesSquare,
  Smartphone,
  TerminalSquare,
} from "lucide-react";
import {
  type ComponentType,
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { openLayerMatches } from "~/lib/openLayers";
import { surfaceShortcutKey } from "~/lib/surfaceShortcutKey";
import { registerCommands } from "~/shortcuts/dispatcher";

import { DraftProjectGroupLabel, DraftProjectRow } from "./chat/DraftHeroHeadline";

/** What a launcher can open for a thread. */
export type LauncherSurfaceKind =
  | "browser"
  | "terminal"
  | "files"
  | "diff"
  | "pull-request"
  | "pull-requests"
  | "device"
  | "side-chat";

const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
]
  .map((selector) => `${selector}:is([data-open],[data-ending-style])`)
  .join(",");

/** The surfaces a launcher offers, in its order, with their letter and one-line hint. */
export const SURFACE_LAUNCHER_ENTRIES: ReadonlyArray<{
  readonly kind: LauncherSurfaceKind;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly shortcut: string;
  /** Why it is unavailable, on the row in place of its detail. */
  readonly hint: string;
}> = [
  {
    kind: "browser",
    label: "Browser",
    icon: Globe2,
    shortcut: "B",
    hint: "Only available in the desktop app.",
  },
  {
    kind: "terminal",
    label: "Terminal",
    icon: TerminalSquare,
    shortcut: "T",
    hint: "Available when a project is open.",
  },
  {
    kind: "files",
    label: "Files",
    icon: Files,
    shortcut: "F",
    hint: "Available when a project is open.",
  },
  {
    kind: "diff",
    label: "Diff",
    icon: FileDiff,
    shortcut: "D",
    hint: "Available for Git repositories.",
  },
  {
    kind: "pull-request",
    label: "Pull request",
    icon: PullRequestGlyph.pullRequest,
    shortcut: "P",
    hint: "No pull request on this branch yet.",
  },
  {
    kind: "pull-requests",
    label: "Linked pull requests",
    icon: PullRequestGlyph.link,
    shortcut: "L",
    hint: "No linked pull requests available.",
  },
  {
    kind: "side-chat",
    label: "Side chat",
    icon: MessagesSquare,
    shortcut: "S",
    hint: "Available after the first message.",
  },
  {
    kind: "device",
    label: "Device",
    icon: Smartphone,
    shortcut: "M",
    hint: "Available from a thread.",
  },
];

export interface SurfaceLauncherAction {
  readonly kind: LauncherSurfaceKind;
  readonly shortcut: string;
  readonly available: boolean;
  /** Shown on the row while unavailable; defaults to the surface's hint. */
  readonly disabledReason?: string;
  readonly onClick: () => void;
}

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
> &
  Partial<Pick<KeyboardEvent, "code" | "getModifierState">>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = surfaceShortcutKey(event);
  return (
    actions.find((action) => action.available && action.shortcut.toLowerCase() === key) ?? null
  );
}

/**
 * The `:not` clause lets `closest` see past non-editable islands
 * (`contenteditable="false"`) to an editable host around them, matching
 * ComposerPendingUserInputPanel's typing guard.
 */
export function surfaceShortcutTargetsTypingContext(
  target: { closest(selectors: string): unknown } | null,
): boolean {
  return (
    target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !=
    null
  );
}

/**
 * Arrows move focus between the launcher's rows; Enter is the focused row's
 * own. Focus may sit on the pane around the launcher (the layout focuses
 * the pane), so this runs from the window rather than the launcher.
 */
function launcherHasFocus(launcher: HTMLElement | null): boolean {
  const active = document.activeElement;
  return !!launcher && !!active && (launcher.contains(active) || active.contains(launcher));
}

function launcherRows(launcher: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    launcher.querySelectorAll<HTMLButtonElement>('[role="listitem"] > button:not(:disabled)'),
  );
}

function moveLauncherFocus(launcher: HTMLElement | null, event: KeyboardEvent): boolean {
  if (!launcher || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
  if (!forward && event.key !== "ArrowUp" && event.key !== "ArrowLeft") return false;
  if (!launcherHasFocus(launcher)) return false;
  const active = document.activeElement;
  const rows = launcherRows(launcher);
  if (rows.length === 0) return false;
  const index = rows.findIndex((row) => row === active);
  const next =
    index === -1
      ? forward
        ? 0
        : rows.length - 1
      : (index + (forward ? 1 : -1) + rows.length) % rows.length;
  rows[next]?.focus();
  return true;
}

/** Capture shortcuts for the focused launcher pane, preserving typing contexts and handled events;
 * row focus alone is too fragile. */
export function useSurfaceLauncherKeys(input: {
  readonly launcherRef: RefObject<HTMLElement | null>;
  readonly activeRef: RefObject<boolean>;
  readonly actions: readonly SurfaceLauncherAction[];
  readonly onClose: (() => void) | undefined;
}): void {
  const { launcherRef, activeRef } = input;
  const handler = useEffectEvent((event: KeyboardEvent) => {
    if (!activeRef.current) return;
    if (openLayerMatches(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
    if (moveLauncherFocus(launcherRef.current, event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape" && input.onClose && launcherHasFocus(launcherRef.current)) {
      event.preventDefault();
      event.stopPropagation();
      input.onClose();
      return;
    }
    const action = surfaceShortcutActionForKey(input.actions, event);
    if (!action) return;
    const target = event.composedPath()[0] ?? event.target;
    if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return;
    event.preventDefault();
    event.stopPropagation();
    action.onClick();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register the launcher capture scope for its mounted lifetime.
  useEffect(
    () =>
      registerCommands(
        {},
        {
          capture: true,
          onKeyDown: (event) => {
            handler(event);
            return event.defaultPrevented;
          },
        },
      ),
    [],
  );
}

/**
 * The "Open a surface" rows, in the new thread hero's style. Unavailable
 * surfaces stay visible with a one-line reason. The browser row offers its
 * profiles once there is more than one to choose between.
 */
export function SurfaceLauncherRows(props: {
  readonly actions: readonly SurfaceLauncherAction[];
  readonly browserProfiles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly onAddBrowserInProfile: (profileId: string) => void;
}) {
  return (
    <>
      <DraftProjectGroupLabel>Open a surface</DraftProjectGroupLabel>
      {SURFACE_LAUNCHER_ENTRIES.map((entry) => {
        const action = props.actions.find((candidate) => candidate.kind === entry.kind);
        if (!action) return null;
        const Icon = entry.icon;
        // Same choice the tab bar's "+" menu offers: the row opens the
        // default profile, the chevron picks another.
        const profileChooser =
          entry.kind === "browser" && action.available && props.browserProfiles.length > 1 ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    aria-label="Open browser in a profile"
                    size="icon-micro"
                    variant="ghost-muted"
                  />
                }
              >
                <ChevronDown />
              </MenuTrigger>
              <MenuPopup align="end" side="bottom" sideOffset={6} className="max-w-56">
                {props.browserProfiles.map((profile) => (
                  <MenuItem
                    key={profile.id}
                    onClick={() => props.onAddBrowserInProfile(profile.id)}
                  >
                    <span className="min-w-0 truncate">{profile.name}</span>
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null;
        return (
          <DraftProjectRow
            key={entry.kind}
            icon={<Icon className="size-4 shrink-0 text-muted-foreground" />}
            label={entry.label}
            detail={action.available ? "" : (action.disabledReason ?? entry.hint)}
            shortcut={entry.shortcut}
            disabled={!action.available}
            action={profileChooser}
            onSelect={action.onClick}
          />
        );
      })}
    </>
  );
}

/** Where the keyboard lands in a launcher: its selected row, else its first, else itself. */
export function launcherFocusTarget(launcher: HTMLElement): HTMLElement {
  return (
    launcher.querySelector<HTMLButtonElement>(
      '[role="listitem"][data-selected] > button:not(:disabled)',
    ) ??
    launcherRows(launcher)[0] ??
    launcher
  );
}

/**
 * The launcher's element, focused on mount when its pane has focus. In the
 * layout strip a plain focus() scrolls the strip, so it never scrolls.
 * `focusFirstRow` puts the keyboard on the selected row, or the first, so
 * Enter picks it.
 */
export function useLauncherElement(
  activeRef: RefObject<boolean>,
  focusFirstRow: boolean,
): [RefObject<HTMLDivElement | null>, (node: HTMLDivElement | null) => void] {
  const launcherRef = useRef<HTMLDivElement | null>(null);
  const focusFirstRowRef = useRef(focusFirstRow);
  // Stable identity so React only runs this callback ref on mount/unmount;
  // an inline arrow would re-attach and re-focus on every render.
  const [attach] = useState(() => (node: HTMLDivElement | null) => {
    launcherRef.current = node;
    if (!node || !activeRef.current) return;
    const active = document.activeElement;
    // Focus held outside the strip (the palette, the sidebar's search) stays.
    if (active && active !== document.body && !active.closest("[data-layout-strip]")) return;
    const target = focusFirstRowRef.current ? launcherFocusTarget(node) : node;
    target.focus({ preventScroll: true });
  });
  return [launcherRef, attach];
}
