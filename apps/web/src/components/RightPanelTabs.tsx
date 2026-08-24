import type { ContextMenuItem, PreviewSessionSnapshot, PullRequestState } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  Bot,
  FileDiff,
  Files,
  GitPullRequest,
  Globe2,
  Gauge,
  Plus,
  TerminalSquare,
  Volume2,
  VolumeOff,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Kbd } from "~/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useTheme } from "~/hooks/useTheme";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { useI18n, type MessageKey, type Translate } from "~/i18n";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { FaviconImage } from "./preview/PreviewFaviconIcon";
import { previewBridge } from "./preview/previewBridge";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  /** Forwarded to PreviewPanelShell so this surface persists its own width. */
  widthStorageKey?: string;
  /** Forwarded to PreviewPanelShell as the initial width before a user resize. */
  defaultWidth?: number;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  /**
   * Maps a server session tab id to the desktop runtime tab id the Electron
   * preview manager is keyed by. Session ids are only unique within one server
   * process, so desktop operations must not be addressed with them.
   */
  previewRuntimeTabId?: ((tabId: string) => string) | undefined;
  terminalLabelsById: ReadonlyMap<string, string>;
  agentTitlesById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddAgents: () => void;
  onAddContext: () => void;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  agentsAvailable: boolean;
  contextAvailable: boolean;
  pullRequestStatuses?: Readonly<Record<string, PullRequestTabStatus>>;
  /** Running + waiting subagents; badges the Agents card in the empty state. */
  liveAgentCount: number;
  children: ReactNode;
}

export interface PullRequestTabStatus {
  projectId: string;
  repository: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
}

const SURFACE_DISABLED_REASON_KEYS = {
  browser: "panel.browserUnavailable",
  terminal: "panel.terminalUnavailable",
  files: "panel.filesUnavailable",
  diff: "panel.diffUnavailable",
  pullRequest: "panel.pullRequestUnavailable",
  agents: "panel.agentsUnavailable",
  context: "panel.contextUnavailable",
} as const satisfies Record<string, MessageKey>;

/** Overlays that must win over the launcher's letter shortcuts. */
const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

/** One-line unavailability hints for the empty-state cards. */
const SURFACE_UNAVAILABLE_HINT_KEYS = {
  browser: "panel.browserUnavailableShort",
  terminal: "panel.terminalUnavailableShort",
  files: "panel.filesUnavailableShort",
  diff: "panel.diffUnavailableShort",
  pullRequest: "panel.pullRequestUnavailableShort",
  agents: "panel.agentsUnavailableShort",
  context: "panel.contextUnavailableShort",
} as const satisfies Record<string, MessageKey>;

type TabContextMenuAction =
  | "copy-path"
  | "toggle-mute"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

/**
 * Desktop preview tab backing a surface, or null for non-preview surfaces, the
 * "new browser tab" placeholder, and the web build where no desktop tab exists.
 */
function previewTabIdOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string | null {
  if (surface.kind !== "preview" || !surface.resourceId) return null;
  return sessions[surface.resourceId]?.tabId ?? null;
}

/**
 * Label and enabled state for a preview tab's mute menu entry.
 * Stays disabled until desktop overlay state arrives: a server session id can
 * resolve while the preview manager's createTab is still in flight, and muting
 * then fails with a PreviewTabNotFoundError nothing surfaces to the user.
 */
export function tabMuteMenuItem(input: {
  overlay: DesktopPreviewOverlay | null;
  canResolveRuntimeTabId: boolean;
}): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? "Unmute tab" : "Mute tab",
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

type TabAudioState = "none" | "audible" | "muted";

/**
 * A muted tab that is not making sound shows nothing: mute is armed silently,
 * and the indicator only appears once there is audio to speak of.
 */
function tabAudioState(overlay: DesktopPreviewOverlay | null): TabAudioState {
  if (!overlay?.audible) return "none";
  return overlay.audioMuted ? "muted" : "audible";
}

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return (
    actions.find(
      (action) => action.available && action.shortcut.toLowerCase() === event.key.toLowerCase(),
    ) ?? null
  );
}

/**
 * A focused editable is a typing context whether or not it has text yet: an
 * empty chat composer at rest is still where the user's next keystrokes are
 * meant to land, and claiming launcher letters from it would redirect prompts
 * into whatever surface opens. The `:not` clause lets `closest` see past
 * non-editable islands (`contenteditable="false"`) to an editable host around
 * them, matching ComposerPendingUserInputPanel's typing guard.
 */
export function surfaceShortcutTargetsTypingContext(
  target: { closest(selectors: string): unknown } | null,
): boolean {
  return (
    target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !=
    null
  );
}

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
      aria-keyshortcuts={props.shortcut}
    >
      {props.children}
      <MenuShortcut>{props.shortcut}</MenuShortcut>
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

/**
 * Card launcher shown when the right panel has no surfaces. Keyboard-first
 * without palette chrome: a surface's letter opens it directly from anywhere
 * outside a typing context, and arrows plus Enter work while the launcher is
 * focused. The highlight only appears on hover or arrow use. Unavailable
 * surfaces stay visible with a one-line reason.
 */
function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddAgents: () => void;
  onAddContext: () => void;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  agentsAvailable: boolean;
  contextAvailable: boolean;
  liveAgentCount: number;
}) {
  const { t } = useI18n();
  // -1 means no highlight: it only appears on hover or arrow use.
  const [highlight, setHighlight] = useState(-1);

  const actions = [
    {
      label: t("panel.browser"),
      description: t("panel.browserDescription"),
      icon: Globe2,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: t(SURFACE_UNAVAILABLE_HINT_KEYS.browser),
      onClick: props.onAddBrowser,
      badgeCount: 0,
    },
    {
      label: t("panel.terminal"),
      description: t("panel.terminalDescription"),
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: t(SURFACE_UNAVAILABLE_HINT_KEYS.terminal),
      onClick: props.onAddTerminal,
      badgeCount: 0,
    },
    {
      label: t("panel.files"),
      description: t("panel.filesDescription"),
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: t(SURFACE_UNAVAILABLE_HINT_KEYS.files),
      onClick: props.onAddFiles,
      badgeCount: 0,
    },
    {
      label: t("panel.diff"),
      description: t("panel.diffDescription"),
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: t(SURFACE_UNAVAILABLE_HINT_KEYS.diff),
      onClick: props.onAddDiff,
      badgeCount: 0,
    },
    {
      label: t("panel.pullRequest"),
      description: t("panel.pullRequestDescription"),
      icon: GitPullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: t(SURFACE_UNAVAILABLE_HINT_KEYS.pullRequest),
      onClick: props.onAddPullRequest,
      badgeCount: 0,
    },
    {
      label: t("panel.agents"),
      description: t("panel.agentsDescription"),
      icon: Bot,
      shortcut: "A",
      available: props.agentsAvailable,
      disabledReason: t(SURFACE_UNAVAILABLE_HINT_KEYS.agents),
      onClick: props.onAddAgents,
      badgeCount: props.liveAgentCount,
    },
    {
      label: t("panel.context"),
      description: t("panel.contextDescription"),
      icon: Gauge,
      shortcut: "C",
      available: props.contextAvailable,
      disabledReason: t(SURFACE_UNAVAILABLE_HINT_KEYS.context),
      onClick: props.onAddContext,
      badgeCount: 0,
    },
  ] as const;

  type SurfaceAction = (typeof actions)[number];

  const availableActions = actions.filter((action) => action.available);
  const highlightIndex =
    availableActions.length === 0 ? -1 : Math.min(highlight, availableActions.length - 1);

  // Letter shortcuts work while the launcher is visible, not only while it
  // is focused; focus moves around too easily (stray clicks) to carry them.
  // Capture phase so app-level key handlers cannot swallow the event first;
  // typing contexts and already-handled events are left alone.
  const shortcutActionsRef = useRef(availableActions);
  useEffect(() => {
    shortcutActionsRef.current = availableActions;
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const action = surfaceShortcutActionForKey(shortcutActionsRef.current, event);
      if (!action) return;
      if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
      const target = event.target;
      if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return;
      event.preventDefault();
      event.stopPropagation();
      action.onClick();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (availableActions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((highlightIndex + 1) % availableActions.length);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        highlightIndex === -1
          ? availableActions.length - 1
          : (highlightIndex - 1 + availableActions.length) % availableActions.length,
      );
      return;
    }
    if (event.key === "Enter") {
      // A focused card button owns its own activation; only open from the
      // highlight when the container itself has focus.
      if (event.target instanceof HTMLElement && event.target.closest("button")) return;
      const action = availableActions[highlightIndex];
      if (!action) return;
      event.preventDefault();
      action.onClick();
    }
  };

  // Stable identity so React only runs this callback ref on mount/unmount;
  // an inline arrow would re-attach and re-focus on every render.
  const focusOnMount = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, []);

  const isHighlighted = (action: SurfaceAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action;

  const actionIcon = (action: SurfaceAction, iconClassName = "size-4") => {
    const Icon = action.icon;
    return (
      <span className="relative inline-flex shrink-0">
        <Icon className={iconClassName} />
        {action.badgeCount > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
          >
            {action.badgeCount}
          </span>
        ) : null}
      </span>
    );
  };

  const cardShellClass =
    "rounded-lg border border-border/80 bg-card dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5";
  const highlightedCardClass = "bg-accent/60 dark:inset-ring-white/20";

  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label={t("panel.openSurface")}
      data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join("")}
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pt-6 outline-none",
        // The panel topbar sits above this container; matching bottom padding
        // keeps the cards centered against the full panel, not the leftover.
        "pb-[calc(var(--workspace-topbar-height)+--spacing(6))]",
      )}
    >
      <div className="relative w-full max-w-lg">
        <div className="absolute inset-x-0 bottom-full mb-5 text-center">
          <h3 className="font-medium text-foreground text-sm">{t("panel.openSurface")}</h3>
          <p className="mt-1 text-muted-foreground text-xs">{t("panel.openSurfaceDescription")}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action) =>
            action.available ? (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                onMouseEnter={() => setHighlight(availableActions.indexOf(action))}
                onMouseLeave={() =>
                  setHighlight((current) =>
                    current === availableActions.indexOf(action) ? -1 : current,
                  )
                }
                className={cn(
                  "relative flex w-full cursor-pointer flex-col items-start p-4 text-left transition hover:border-border hover:bg-accent/60",
                  cardShellClass,
                  isHighlighted(action) && highlightedCardClass,
                )}
              >
                <Kbd className="absolute top-3 right-3">{action.shortcut}</Kbd>
                <span className="flex items-center gap-2 pe-8">
                  {actionIcon(action)}
                  <span className="font-medium text-sm">{action.label}</span>
                </span>
                <span className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                  {action.description}
                </span>
              </button>
            ) : (
              <div
                key={action.label}
                className={cn(
                  "relative flex w-full flex-col items-start p-4 opacity-40",
                  cardShellClass,
                )}
              >
                <Kbd className="absolute top-3 right-3">{action.shortcut}</Kbd>
                <span className="flex items-center gap-2 pe-8">
                  {actionIcon(action)}
                  <span className="font-medium text-sm">{action.label}</span>
                </span>
                <span className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                  {action.disabledReason}
                </span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
  agentTitlesById: ReadonlyMap<string, string>,
  t: Translate,
): string {
  switch (surface.kind) {
    case "diff":
      return t("panel.diff");
    case "files":
      return t("panel.files");
    case "file":
      return surface.relativePath.slice(surface.relativePath.lastIndexOf("/") + 1);
    case "terminal":
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      );
    case "pull-request":
      return `#${surface.number}`;
    case "agents":
      return agentTitlesById.get(surface.agentId) ?? t("panel.agents");
    case "context":
      return t("panel.context");
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return t("panel.browser");
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || t("panel.browser");
      } catch {
        return t("panel.browser");
      }
    }
  }
}

function PreviewFavicon({ capturedUrl, url }: { capturedUrl: string | null; url: string | null }) {
  const publicProviderUrl = faviconUrlForOrigin(url, 32);
  return (
    <FaviconImage
      sources={[capturedUrl, publicProviderUrl]}
      fallback={<Globe2 className="size-3 shrink-0" />}
      className="size-3 shrink-0 rounded-sm object-contain"
    />
  );
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function SurfaceIcon({
  surface,
  sessions,
  desktopByTabId,
  theme,
  pullRequestStatuses,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  theme: "light" | "dark";
  pullRequestStatuses: Readonly<Record<string, PullRequestTabStatus>> | undefined;
}) {
  switch (surface.kind) {
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      const favicon = snapshot ? (desktopByTabId[snapshot.tabId]?.favicon ?? null) : null;
      const capturedUrl =
        favicon && url && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
      return <PreviewFavicon capturedUrl={capturedUrl} url={url} />;
    }
    case "diff":
      return <FileDiff className="size-3 shrink-0" />;
    case "files":
      return <Files className="size-3 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3 shrink-0" />;
    case "pull-request": {
      const status = pullRequestStatuses?.[surface.id] ?? null;
      const toneClassName =
        status?.state === "merged"
          ? "text-violet-600 dark:text-violet-300/90"
          : status?.state === "closed"
            ? "text-red-600 dark:text-red-300/90"
            : status?.isDraft
              ? "text-zinc-500 dark:text-zinc-400/80"
              : status?.state === "open"
                ? "text-emerald-600 dark:text-emerald-300/90"
                : "text-muted-foreground";
      return <GitPullRequest className={cn("size-3 shrink-0", toneClassName)} />;
    }
    case "agents":
      return <Bot className="size-3 shrink-0" />;
    case "context":
      return <Gauge className="size-3 shrink-0" />;
  }
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const { t } = useI18n();
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  const [addSurfaceMenuOpen, setAddSurfaceMenuOpen] = useState(false);

  const addSurfaceActions = [
    {
      label: t("panel.browser"),
      icon: Globe2,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: t(SURFACE_DISABLED_REASON_KEYS.browser),
      onClick: props.onAddBrowser,
    },
    {
      label: t("panel.terminal"),
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: t(SURFACE_DISABLED_REASON_KEYS.terminal),
      onClick: props.onAddTerminal,
    },
    {
      label: t("panel.files"),
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: t(SURFACE_DISABLED_REASON_KEYS.files),
      onClick: props.onAddFiles,
    },
    {
      label: t("panel.diff"),
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: t(SURFACE_DISABLED_REASON_KEYS.diff),
      onClick: props.onAddDiff,
    },
    {
      label: t("panel.pullRequest"),
      icon: GitPullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: t(SURFACE_DISABLED_REASON_KEYS.pullRequest),
      onClick: props.onAddPullRequest,
    },
    {
      label: t("panel.agents"),
      icon: Bot,
      shortcut: "A",
      available: props.agentsAvailable,
      disabledReason: t(SURFACE_DISABLED_REASON_KEYS.agents),
      onClick: props.onAddAgents,
    },
    {
      label: t("panel.context"),
      icon: Gauge,
      shortcut: "C",
      available: props.contextAvailable,
      disabledReason: t(SURFACE_DISABLED_REASON_KEYS.context),
      onClick: props.onAddContext,
    },
  ] as const;

  const handleAddSurfaceMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = surfaceShortcutActionForKey(addSurfaceActions, event.nativeEvent);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    setAddSurfaceMenuOpen(false);
    action.onClick();
  };

  const handleTabContextMenu = useCallback(
    async (event: ReactMouseEvent, surface: RightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "file") {
        items.push({ id: "copy-path", label: t("panel.copyPath") });
      }
      const menuPreviewTabId = previewTabIdOf(surface, props.previewSessions);
      // Desktop overlay state only arrives once the preview manager has created
      // the tab. A server session id alone can still be ahead of that, and
      // muting then fails with PreviewTabNotFoundError that nobody surfaces.
      const menuOverlay = menuPreviewTabId
        ? (props.desktopByTabId[menuPreviewTabId] ?? null)
        : null;
      const menuMuted = menuOverlay?.audioMuted ?? false;
      if (surface.kind === "preview") {
        // Not gated on audibility: silencing a quiet tab ahead of time is the
        // point, so the item is offered whenever the tab is mutable at all.
        items.push({
          id: "toggle-mute",
          ...tabMuteMenuItem({
            overlay: menuOverlay,
            canResolveRuntimeTabId: props.previewRuntimeTabId !== undefined,
          }),
          label: t(menuMuted ? "panel.unmuteTab" : "panel.muteTab"),
        });
      }
      items.push(
        { id: "close", label: t("panel.close") },
        {
          id: "close-others",
          label: t("panel.closeOthers"),
          disabled: props.surfaces.length <= 1,
        },
        {
          id: "close-to-right",
          label: t("panel.closeRight"),
          disabled: surfaceIndex >= props.surfaces.length - 1,
        },
        {
          id: "close-all",
          label: t("panel.closeAll"),
          disabled: props.surfaces.length === 0,
        },
      );

      const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
      switch (action) {
        case "copy-path":
          if (surface.kind === "file") props.onCopyFilePath(surface.relativePath);
          break;
        case "toggle-mute": {
          // menuOverlay repeats the disabled gate above: the desktop tab must
          // exist before it can be addressed, however the menu was dismissed.
          const runtimeTabId =
            menuPreviewTabId && menuOverlay
              ? (props.previewRuntimeTabId?.(menuPreviewTabId) ?? null)
              : null;
          if (runtimeTabId) {
            void previewBridge?.setAudioMuted(runtimeTabId, !menuMuted).catch(() => undefined);
          }
          break;
        }
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [props, t],
  );
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );
  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const tabs = Array.from(
        tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
      );
      const currentIndex = tabs.indexOf(event.currentTarget);
      if (currentIndex < 0 || tabs.length === 0) return;

      let nextIndex: number | null = null;
      if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      else if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex === null) return;

      event.preventDefault();
      const nextSurface = props.surfaces[nextIndex];
      const nextTab = tabs[nextIndex];
      if (!nextSurface || !nextTab) return;
      props.onActivate(nextSurface);
      nextTab.focus();
    },
    [props],
  );

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
    >
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
          // The sheet overlays from the viewport top, so its tab bar keeps
          // the titlebar's height: a compact row re-centers the layout
          // controls a few pixels higher and the cluster jumps on open.
          props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3",
          ownsDesktopTitleBar && "wco:pr-[calc(var(--workspace-native-controls-inset)+6rem)]",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          ref={tabListRef}
          hideScrollbars
          scrollFade
          className={cn("min-w-0 flex-1 rounded-none", ownsDesktopTitleBar && "drag-region")}
          data-right-panel-tab-list
        >
          <div
            className="flex h-full w-max min-w-full items-center gap-1"
            role="tablist"
            aria-label={t("panel.tabs")}
          >
            {props.surfaces.map((surface) => {
              const active = surface.id === props.activeSurfaceId;
              const pending = props.pendingSurfaceIds.has(surface.id);
              const title = surfaceTitle(
                surface,
                props.previewSessions,
                props.terminalLabelsById,
                props.agentTitlesById,
                t,
              );
              const previewTabId = previewTabIdOf(surface, props.previewSessions);
              // Desktop state is keyed by the session id, but desktop actions
              // must be addressed with the runtime id.
              const audio = tabAudioState(
                previewTabId ? (props.desktopByTabId[previewTabId] ?? null) : null,
              );
              const audioRuntimeTabId = previewTabId
                ? (props.previewRuntimeTabId?.(previewTabId) ?? null)
                : null;
              return (
                <div
                  key={surface.id}
                  data-active-tab={active}
                  onMouseDown={handleTabMouseDown}
                  onAuxClick={(event) => handleTabAuxClick(event, surface)}
                  onContextMenu={(event) => void handleTabContextMenu(event, surface)}
                  className={cn(
                    "cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <span className="relative flex size-4 shrink-0 items-center justify-center">
                    <SurfaceIcon
                      surface={surface}
                      sessions={props.previewSessions}
                      desktopByTabId={props.desktopByTabId}
                      theme={resolvedTheme}
                      pullRequestStatuses={props.pullRequestStatuses}
                    />
                    {pending ? (
                      <span
                        className="absolute right-0 bottom-0 size-1.5 rounded-full bg-current"
                        aria-hidden
                      />
                    ) : null}
                  </span>
                  {audio === "none" || !audioRuntimeTabId ? null : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            className="cursor-pointer flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
                            aria-label={t(
                              audio === "muted" ? "panel.unmuteNamed" : "panel.muteNamed",
                              {
                                title,
                              },
                            )}
                            onClick={(event) => {
                              // Sibling of the close button, inside a tab that
                              // activates on click: keep this to the toggle.
                              event.stopPropagation();
                              void previewBridge
                                ?.setAudioMuted(audioRuntimeTabId, audio !== "muted")
                                .catch(() => undefined);
                            }}
                          >
                            {audio === "muted" ? (
                              <VolumeOff className="size-3" />
                            ) : (
                              <Volume2 className="size-3" />
                            )}
                          </button>
                        }
                      />
                      <TooltipPopup>
                        {t(audio === "muted" ? "panel.unmuteTab" : "panel.muteTab")}
                      </TooltipPopup>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          role="tab"
                          aria-selected={active}
                          tabIndex={active ? 0 : -1}
                          className="cursor-pointer flex min-w-0 flex-1 items-center"
                          onClick={() => props.onActivate(surface)}
                          onKeyDown={handleTabKeyDown}
                        >
                          <span className="truncate">{title}</span>
                        </button>
                      }
                    />
                    <TooltipPopup>{title}</TooltipPopup>
                  </Tooltip>
                  <button
                    type="button"
                    className="cursor-pointer flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t("panel.closeNamed", { title })}
                    onClick={() => props.onCloseSurface(surface)}
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </div>
              );
            })}
            {props.surfaces.length > 0 ? (
              <Menu open={addSurfaceMenuOpen} onOpenChange={setAddSurfaceMenuOpen}>
                <MenuTrigger
                  render={
                    <Button
                      aria-label={t("panel.addSurface")}
                      className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                >
                  <Plus className="size-3.5" />
                </MenuTrigger>
                <MenuPopup
                  align="start"
                  side="bottom"
                  sideOffset={6}
                  className="min-w-44"
                  onKeyDownCapture={handleAddSurfaceMenuKeyDown}
                >
                  {addSurfaceActions.map((action) => {
                    const Icon = action.icon;
                    return (
                      <SurfaceMenuItem
                        key={action.label}
                        available={action.available}
                        disabledReason={action.disabledReason}
                        shortcut={action.shortcut}
                        onClick={action.onClick}
                      >
                        <Icon />
                        {action.label}
                      </SurfaceMenuItem>
                    );
                  })}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </ScrollArea>
        {props.layoutControls}
      </div>
      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-surface-content>
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddPullRequest={props.onAddPullRequest}
            onAddAgents={props.onAddAgents}
            onAddContext={props.onAddContext}
            browserAvailable={props.browserAvailable}
            terminalAvailable={props.terminalAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            pullRequestAvailable={props.pullRequestAvailable}
            agentsAvailable={props.agentsAvailable}
            contextAvailable={props.contextAvailable}
            liveAgentCount={props.liveAgentCount}
          />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}
