import {
  ChevronDown,
  FileDiff,
  Files,
  Globe2,
  MessagesSquare,
  Smartphone,
  SquarePen,
  TerminalSquare,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { openLayerMatches } from "~/lib/openLayers";
import { surfaceShortcutKey } from "~/lib/surfaceShortcutKey";
import { registerCommands } from "~/shortcuts/dispatcher";

import {
  DRAFT_PROJECT_ROW_ACTION_CLASS,
  DRAFT_PROJECT_ROW_BUTTON_CLASS,
  DRAFT_PROJECT_ROW_CLASS,
  DRAFT_PROJECT_ROW_LABEL_CLASS,
  DraftProjectGroupLabel,
  DraftProjectRow,
} from "./chat/DraftHeroHeadline";

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

export interface SurfaceMenuAction {
  readonly kind: LauncherSurfaceKind | "new-thread";
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly shortcut: string;
  readonly available: boolean;
  readonly disabledReason?: string | undefined;
  readonly onClick: () => void;
}

/** The "+" menus' rows: a new thread when offered, then the launcher's surfaces in its order. */
export function surfaceMenuActions(input: {
  readonly onNewThread?: (() => void) | undefined;
  readonly surfaces: Partial<
    Record<
      LauncherSurfaceKind,
      {
        readonly available: boolean;
        readonly disabledReason?: string | undefined;
        readonly onClick: () => void;
      }
    >
  >;
}): SurfaceMenuAction[] {
  const actions: SurfaceMenuAction[] = input.onNewThread
    ? [
        {
          kind: "new-thread",
          label: "New thread",
          icon: SquarePen,
          shortcut: "N",
          available: true,
          onClick: input.onNewThread,
        },
      ]
    : [];
  for (const entry of SURFACE_LAUNCHER_ENTRIES) {
    const surface = input.surfaces[entry.kind];
    if (!surface) continue;
    actions.push({
      kind: entry.kind,
      label: entry.label,
      icon: entry.icon,
      shortcut: entry.shortcut,
      available: surface.available,
      disabledReason: surface.disabledReason,
      onClick: surface.onClick,
    });
  }
  return actions;
}

function MenuKbd(props: { readonly shortcut: string }) {
  return (
    <span className="ms-auto shrink-0 ps-4">
      <Kbd>{props.shortcut}</Kbd>
    </span>
  );
}

/**
 * The rows of a "+" menu. Browser offers its profiles as a submenu once
 * there is more than one, as the launcher's chevron does.
 */
export function SurfaceMenuItems(props: {
  readonly actions: readonly SurfaceMenuAction[];
  readonly browserProfiles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly onAddBrowserInProfile: (profileId: string) => void;
  readonly onClose: () => void;
}) {
  return props.actions.map((action) => {
    const Icon = action.icon;
    if (action.kind === "browser" && action.available && props.browserProfiles.length > 1) {
      return (
        <MenuSub key={action.kind}>
          <MenuSubTrigger
            className="[&>svg:last-child]:ms-0"
            aria-keyshortcuts={action.shortcut}
            onClick={(event) => {
              const pointerType =
                "pointerType" in event.nativeEvent &&
                typeof event.nativeEvent.pointerType === "string"
                  ? event.nativeEvent.pointerType
                  : undefined;
              if (pointerType === "touch") return;
              props.onClose();
              action.onClick();
            }}
          >
            <Icon />
            {action.label}
            <MenuKbd shortcut={action.shortcut} />
          </MenuSubTrigger>
          <MenuSubPopup className="max-w-56">
            {props.browserProfiles.map((profile) => (
              <MenuItem key={profile.id} onClick={() => props.onAddBrowserInProfile(profile.id)}>
                <span className="min-w-0 truncate">{profile.name}</span>
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      );
    }
    const item = (
      <MenuItem
        key={action.kind}
        className={!action.available ? "data-disabled:pointer-events-auto" : undefined}
        onClick={action.onClick}
        disabled={!action.available}
        aria-keyshortcuts={action.shortcut}
      >
        <Icon />
        {action.label}
        <MenuKbd shortcut={action.shortcut} />
      </MenuItem>
    );
    if (action.available || !action.disabledReason) return item;
    return (
      <Tooltip key={action.kind}>
        <TooltipTrigger render={item} />
        <TooltipPopup side="top">{action.disabledReason}</TooltipPopup>
      </Tooltip>
    );
  });
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

function verticalLauncherNeighbor(
  rows: readonly HTMLButtonElement[],
  index: number,
  forward: boolean,
): HTMLButtonElement | undefined {
  const rectOf = (row: HTMLButtonElement) => (row.parentElement ?? row).getBoundingClientRect();
  const from = rectOf(rows[index]!);
  const column = rows.flatMap((row, candidate) => {
    if (candidate === index) return [];
    const rect = rectOf(row);
    return rect.left < from.right && rect.right > from.left ? [{ row, top: rect.top }] : [];
  });
  const ahead = column.filter(({ top }) => (forward ? top > from.top : top < from.top));
  const pool = ahead.length > 0 ? ahead : column;
  const target = (forward ? Math.min : Math.max)(...pool.map(({ top }) => top));
  return pool.find(({ top }) => top === target)?.row;
}

function moveLauncherFocus(launcher: HTMLElement | null, event: KeyboardEvent): boolean {
  if (!launcher || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
  const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
  if (!vertical && event.key !== "ArrowRight" && event.key !== "ArrowLeft") return false;
  if (!launcherHasFocus(launcher)) return false;
  const active = document.activeElement;
  const rows = launcherRows(launcher);
  if (rows.length === 0) return false;
  const index = rows.findIndex((row) => row === active);
  if (index !== -1 && vertical) {
    (verticalLauncherNeighbor(rows, index, forward) ?? rows[index])?.focus();
    return true;
  }
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

function BrowserProfileChooser(props: {
  readonly browserProfiles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly onAddBrowserInProfile: (profileId: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button aria-label="Open browser in a profile" size="icon-micro" variant="ghost-muted" />
        }
      >
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" sideOffset={6} className="max-w-56">
        {props.browserProfiles.map((profile) => (
          <MenuItem key={profile.id} onClick={() => props.onAddBrowserInProfile(profile.id)}>
            <span className="min-w-0 truncate">{profile.name}</span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
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
            <BrowserProfileChooser
              browserProfiles={props.browserProfiles}
              onAddBrowserInProfile={props.onAddBrowserInProfile}
            />
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

function SurfaceLauncherCell(props: {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly shortcut: string;
  readonly action?: ReactNode;
  readonly onSelect: () => void;
}) {
  return (
    <div role="listitem" className={DRAFT_PROJECT_ROW_CLASS}>
      <button type="button" onClick={props.onSelect} className={DRAFT_PROJECT_ROW_BUTTON_CLASS}>
        {props.icon}
        <span className={DRAFT_PROJECT_ROW_LABEL_CLASS}>{props.label}</span>
        <span className="flex min-w-0 flex-1 items-center justify-end gap-2 ps-3.5 text-dim-foreground text-meta">
          {props.detail ? <span className="shrink-0 whitespace-nowrap">{props.detail}</span> : null}
          <Kbd>{props.shortcut}</Kbd>
        </span>
      </button>
      {props.action ? <div className={DRAFT_PROJECT_ROW_ACTION_CLASS}>{props.action}</div> : null}
    </div>
  );
}

export function SurfaceLauncherGrid(props: {
  readonly actions: readonly SurfaceLauncherAction[];
  readonly browserProfiles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly onAddBrowserInProfile: (profileId: string) => void;
}) {
  return (
    <div className="@container">
      <div className="grid grid-cols-[repeat(2,minmax(max-content,1fr))] gap-x-7 gap-y-0.5 @max-[26.75rem]:grid-cols-[minmax(0,1fr)]">
        {SURFACE_LAUNCHER_ENTRIES.map((entry) => {
          const action = props.actions.find((candidate) => candidate.kind === entry.kind);
          if (!action?.available) return null;
          const Icon = entry.icon;
          return (
            <SurfaceLauncherCell
              key={entry.kind}
              icon={<Icon className="size-4 shrink-0 text-muted-foreground" />}
              label={entry.label}
              shortcut={entry.shortcut}
              action={
                entry.kind === "browser" && props.browserProfiles.length > 1 ? (
                  <BrowserProfileChooser
                    browserProfiles={props.browserProfiles}
                    onAddBrowserInProfile={props.onAddBrowserInProfile}
                  />
                ) : null
              }
              onSelect={action.onClick}
            />
          );
        })}
      </div>
    </div>
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
