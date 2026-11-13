import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalOutputCursor,
  type TerminalOutputUpdate,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import {
  Plus,
  Square,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import {
  AuthPreviewOperateScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type ContextMenuItem,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as Schema from "effect/Schema";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Button } from "~/components/ui/button";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readTextFromClipboard, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import {
  GhosttyTerminalSurface,
  type GhosttyTerminalSurfaceOptions,
} from "~/terminal/ghostty/surface";
import { type GhosttyColor, type GhosttyTheme } from "~/terminal/ghostty/core";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { isTerminalUrl } from "../terminal-links";
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalSplitVerticalShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../types";
import { readLocalApi } from "~/localApi";
import { confirmTerminalClose } from "~/lib/terminalCloseConfirm";
import { useClientSettings } from "../hooks/useSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { attachedTerminalSessionAtom } from "../state/terminalSessions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { previewEnvironment } from "../state/preview";
import { readEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useEnvironmentScope } from "../state/session";
import { openTerminalLinkInPreview } from "./preview/openTerminalLinkInPreview";
import { useAtomCommand } from "../state/use-atom-command";
import { preventTerminalCloseShortcut } from "../lib/terminalCloseShortcut";
import { observeResize } from "../lib/observeResize";
import {
  consumePendingTerminalFocus,
  focusTerminal,
  focusTerminalViewport,
  registerTerminalFocusTarget,
} from "../lib/terminalFocus";
import {
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../appearanceFonts";
import { TerminalSessionViewport } from "./ThreadTerminalDrawerParts";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;

interface DrawerLayout {
  viewportHeight: number;
  chatColumnHeight?: number;
  headerHeight?: number;
  composerHeight?: number;
}

function resolveTerminalDrawerMaxHeight(input: DrawerLayout): number {
  const windowCap = Math.max(
    MIN_DRAWER_HEIGHT,
    Math.floor(input.viewportHeight * MAX_DRAWER_HEIGHT_RATIO),
  );
  if (input.chatColumnHeight === undefined) return windowCap;
  // The composer overlays the timeline, so flex layout cannot reserve its
  // height; without this cap a tall drawer pushes it into the header.
  return Math.min(
    windowCap,
    Math.max(0, input.chatColumnHeight - (input.headerHeight ?? 0) - (input.composerHeight ?? 0)),
  );
}

const DRAG_HEIGHT_PROPERTY = "--terminal-drawer-drag-height";

function clampDrawerHeight(height: number, maxHeight: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function chatColumnOf(drawer: HTMLElement | null): HTMLElement | null {
  return drawer?.closest<HTMLElement>("[data-chat-column]") ?? null;
}

function readDrawerLayout(column: HTMLElement | null): Omit<DrawerLayout, "composerHeight"> {
  const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  if (!column) return { viewportHeight };
  return {
    viewportHeight,
    chatColumnHeight: column.clientHeight,
    headerHeight: column.querySelector<HTMLElement>("[data-chat-header]")?.offsetHeight ?? 0,
  };
}

export function writeSystemMessage(
  terminal: Pick<GhosttyTerminalSurface, "write">,
  message: string,
): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

export function writeTerminalOutputUpdate(
  terminal: Pick<GhosttyTerminalSurface, "resetAndWrite" | "write">,
  update: TerminalOutputUpdate,
): void {
  if (update.type === "reset") {
    terminal.resetAndWrite(update.data);
  } else if (update.type === "append") {
    terminal.write(update.data);
  }
}

// Avoid formatting unbounded scrollback selections on every output update.
const MAX_COMPARED_SELECTION_CELLS = 3_000;

export function synchronizeTerminalOutput(
  terminal: Pick<
    GhosttyTerminalSurface,
    "resetAndWrite" | "write" | "getSelection" | "getSelectionCellCount" | "clearSelection"
  >,
  session: Pick<TerminalSessionState, "output" | "version">,
  cursor: TerminalOutputCursor,
): TerminalOutputCursor {
  if (session.version === 0) return cursor;
  const update = readTerminalOutputUpdate(session.output, cursor);
  if (update.type === "none") return update.cursor;
  const cells = terminal.getSelectionCellCount();
  const compared = cells <= MAX_COMPARED_SELECTION_CELLS;
  const selection = cells > 0 && compared ? terminal.getSelection() : "";
  writeTerminalOutputUpdate(terminal, update);
  if (!compared || (cells > 0 && terminal.getSelection() !== selection)) {
    terminal.clearSelection();
  }
  return update.cursor;
}

/** Writes what changed between two session notifications: new output, then a new error. */
export function synchronizeTerminalSession(
  terminal: Parameters<typeof synchronizeTerminalOutput>[0],
  previous: Pick<TerminalSessionState, "output" | "version" | "error">,
  session: Pick<TerminalSessionState, "output" | "version" | "error">,
  cursor: TerminalOutputCursor,
): TerminalOutputCursor {
  const nextCursor =
    session.version === previous.version && session.output === previous.output
      ? cursor
      : synchronizeTerminalOutput(terminal, session, cursor);
  // An attach failure can change only the error, keeping the last buffer.
  if (session.error !== null && session.error !== previous.error) {
    writeSystemMessage(terminal, session.error);
  }
  return nextCursor;
}

function parseTerminalColor(value: string, fallback: GhosttyColor): GhosttyColor {
  if (typeof document === "undefined") return fallback;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;

  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha === 0) return fallback;

  return {
    r: red ?? fallback.r,
    g: green ?? fallback.g,
    b: blue ?? fallback.b,
  };
}

function hexToGhosttyColor(hex: string): GhosttyColor {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

const TERMINAL_PALETTES = {
  light: [
    "#000000",
    "#cd3131",
    "#107c10",
    "#949800",
    "#0451a5",
    "#bc05bc",
    "#0598bc",
    "#555555",
    "#666666",
    "#cd3131",
    "#14ce14",
    "#b5ba00",
    "#0451a5",
    "#bc05bc",
    "#0598bc",
    "#a5a5a5",
  ].map(hexToGhosttyColor),
  dark: [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#e5e5e5",
  ].map(hexToGhosttyColor),
};

// Read visibility when WASM finishes loading, not when setup starts.
export function withLiveVisibility(
  visibleRef: { readonly current: boolean },
  options: Omit<GhosttyTerminalSurfaceOptions, "visible">,
): GhosttyTerminalSurfaceOptions {
  return {
    ...options,
    get visible() {
      return visibleRef.current;
    },
  };
}

function runtimeEnvSignature(runtimeEnv: Record<string, string> | undefined): string {
  if (!runtimeEnv) return "";
  return JSON.stringify(
    Object.entries(runtimeEnv)
      .filter(([key, value]) => key.length > 0 && typeof value === "string")
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  );
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

function readThemeColor(styles: CSSStyleDeclaration, variable: string, fallback: string): string {
  return normalizeComputedColor(styles.getPropertyValue(variable), fallback);
}

export function terminalFontOptions(family: string, size: number): { family?: string; size: number } {
  const trimmed = family.trim();
  return trimmed.length > 0 ? { family: trimmed, size } : { size };
}

export function terminalThemeFromApp(mountElement?: HTMLElement | null): GhosttyTheme {
  const drawerSurface =
    mountElement?.closest("[data-thread-terminal-drawer]") ??
    document.querySelector("[data-thread-terminal-drawer]") ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const themeStyles = mountElement ? getComputedStyle(mountElement) : drawerStyles;
  const colorScheme = themeStyles.colorScheme;
  const isDark =
    colorScheme === "dark"
      ? true
      : colorScheme === "light"
        ? false
        : document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const bodyStyles = getComputedStyle(document.body);
  const rootThemeStyles = getComputedStyle(document.documentElement);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );
  const terminalBackground = readThemeColor(
    themeStyles,
    "--terminal-background",
    readThemeColor(rootThemeStyles, "--terminal-background", background),
  );
  const terminalForeground = readThemeColor(
    themeStyles,
    "--terminal-foreground",
    readThemeColor(rootThemeStyles, "--terminal-foreground", foreground),
  );
  const terminalCursor = readThemeColor(
    themeStyles,
    "--terminal-cursor",
    isDark ? "rgb(180, 203, 255)" : "rgb(38, 56, 78)",
  );
  const terminalSelection = readThemeColor(
    themeStyles,
    "--terminal-selection-background",
    isDark ? "rgba(180, 203, 255, 0.25)" : "rgba(37, 63, 99, 0.2)",
  );
  return {
    background: parseTerminalColor(
      terminalBackground,
      isDark ? { r: 14, g: 18, b: 24 } : { r: 255, g: 255, b: 255 },
    ),
    foreground: parseTerminalColor(
      terminalForeground,
      isDark ? { r: 237, g: 241, b: 247 } : { r: 28, g: 33, b: 41 },
    ),
    cursor: parseTerminalColor(
      terminalCursor,
      isDark ? { r: 180, g: 203, b: 255 } : { r: 38, g: 56, b: 78 },
    ),
    palette: TERMINAL_PALETTES[isDark ? "dark" : "light"],
    selectionBackground: terminalSelection,
  };
}

export function terminalSelectionLineRange(position: { start: { y: number }; end: { y: number } }): {
  lineStart: number;
  lineEnd: number;
} {
  const lineStart = position.start.y + 1;
  return {
    lineStart,
    lineEnd: Math.max(lineStart, position.end.y + 1),
  };
}

export type TerminalContextMenuAction =
  | "add-to-chat"
  | "copy"
  | "paste"
  | "select-all"
  | "scroll-to-bottom";

export function terminalSelectionMenuItems(options?: {
  canAddToChat?: boolean;
}): ContextMenuItem<"add-to-chat" | "copy">[] {
  return [
    ...(options?.canAddToChat === false
      ? []
      : ([{ id: "add-to-chat", label: "Add to chat" }] satisfies ContextMenuItem<"add-to-chat">[])),
    { id: "copy", label: "Copy" },
  ];
}

export function terminalContextMenuItems(options: {
  hasSelection: boolean;
  canAddToChat?: boolean;
  readOnly?: boolean;
}): ContextMenuItem<TerminalContextMenuAction>[] {
  const { hasSelection, canAddToChat = true } = options;
  return [
    ...terminalSelectionMenuItems({ canAddToChat }).map((item) => ({
      ...item,
      disabled: !hasSelection,
    })),
    { id: "paste", label: "Paste", ...(options.readOnly ? { disabled: true } : {}) },
    { id: "select-all", label: "Select all" },
    { id: "scroll-to-bottom", label: "Jump to latest" },
  ];
}

/** A superseded popup's unsettled promise must not cancel the newer right-click flow. */
export function shouldClearTerminalSelectionAction(options: {
  actionPending: boolean;
  openMenuRequestId: number | null;
  currentRequestId: number;
}): boolean {
  return options.actionPending || options.openMenuRequestId === options.currentRequestId;
}

/**
 * A writable session's output generation. A new one is a fresh PTY (or a
 * reconnect) that has not seen the surface's grid yet.
 */
export function writableSessionGeneration(
  session: TerminalSessionState,
  canOperate: boolean,
): number | null {
  return canOperate && session.version > 0 && session.status === "running"
    ? session.output.generation
    : null;
}

export function shouldHandleTerminalExit(
  current: TerminalSessionState["status"],
  synchronized: TerminalSessionState["status"],
  alreadyHandled: boolean,
  version: number,
): boolean {
  return (
    version > 0 &&
    (current === "closed" || current === "exited") &&
    current !== synchronized &&
    !alreadyHandled
  );
}

export interface TerminalViewportProps {
  advancedTypography: boolean;
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  providerInstanceId?: ProviderInstanceId;
  onSessionExited: () => void;
  onAddTerminalContext?: (selection: TerminalContextSelection) => void;
  /** Focuses the viewport when it mounts; otherwise focus arrives through `focusTerminal`. */
  autoFocus?: boolean;
  visible: boolean;
  keybindings: ResolvedKeybindingsConfig;
}

interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly runtimeEnv?: Record<string, string>;
}

export function TerminalViewport(props: TerminalViewportProps) {
  const sessionKey = JSON.stringify([
    props.threadRef.environmentId,
    props.threadId,
    props.terminalId,
    props.cwd,
    props.worktreePath ?? null,
    runtimeEnvSignature(props.runtimeEnv),
  ]);
  return <TerminalSessionViewport key={sessionKey} {...props} />;
}

interface ThreadTerminalDrawerProps {
  mode?: "drawer" | "panel";
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  height: number;
  /** Space the chat column keeps for the composer overlay; only read in drawer mode. */
  composerHeight?: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  keybindings: ResolvedKeybindingsConfig;
  terminalLabelsById?: ReadonlyMap<string, string>;
  terminalLaunchLocationsById?: ReadonlyMap<string, TerminalLaunchLocation>;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}

function TerminalActionButton({
  label,
  className,
  onClick,
  children,
  disabled,
}: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={
          <button
            type="button"
            className={cn(className, disabled && "opacity-64 cursor-not-allowed")}
            onClick={disabled ? undefined : onClick}
            aria-label={label}
            aria-disabled={disabled}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

function TerminalSplitPanes({
  terminalIds,
  splitDirection,
  activeTerminalId,
  terminalLabelById,
  resolveLaunchLocation,
  onActiveTerminalChange,
  onCloseTerminal,
  advancedTypography,
  threadRef,
  threadId,
  onAddTerminalContext,
  visible,
  keybindings,
}: {
  terminalIds: readonly string[];
  splitDirection: "horizontal" | "vertical";
  activeTerminalId: string;
  terminalLabelById: ReadonlyMap<string, string>;
  resolveLaunchLocation: (terminalId: string) => TerminalLaunchLocation;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
  advancedTypography: boolean;
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  visible: boolean;
  keybindings: ResolvedKeybindingsConfig;
}) {
  return (
    <div
      className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
      style={
        splitDirection === "vertical"
          ? {
              gridTemplateRows: `repeat(${terminalIds.length}, minmax(0, 1fr))`,
            }
          : {
              gridTemplateColumns: `repeat(${terminalIds.length}, minmax(0, 1fr))`,
            }
      }
    >
      {terminalIds.map((terminalId) => {
        const terminalLaunchLocation = resolveLaunchLocation(terminalId);
        return (
          <div
            key={terminalId}
            className={`min-h-0 min-w-0 ${
              splitDirection === "vertical"
                ? "border-t first:border-t-0"
                : "border-l first:border-l-0"
            } ${terminalId === activeTerminalId ? "border-border" : "border-border/70"}`}
            onPointerDown={() => {
              if (terminalId !== activeTerminalId) {
                onActiveTerminalChange(terminalId);
              }
            }}
          >
            <div className="h-full">
              <TerminalViewport
                advancedTypography={advancedTypography}
                threadRef={threadRef}
                threadId={threadId}
                terminalId={terminalId}
                terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
                cwd={terminalLaunchLocation.cwd}
                {...(terminalLaunchLocation.worktreePath !== undefined
                  ? { worktreePath: terminalLaunchLocation.worktreePath }
                  : {})}
                {...(terminalLaunchLocation.runtimeEnv
                  ? { runtimeEnv: terminalLaunchLocation.runtimeEnv }
                  : {})}
                onSessionExited={() => onCloseTerminal(terminalId, threadRef)}
                onAddTerminalContext={onAddTerminalContext}
                visible={visible}
                keybindings={keybindings}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TerminalSidebarGroup({
  terminalGroup,
  activeTerminalId,
  showHeader,
  terminalLabelById,
  closeShortcutLabel,
  canOperateTerminal,
  onActiveTerminalChange,
  onCloseTerminal,
}: {
  terminalGroup: ThreadTerminalGroup;
  activeTerminalId: string;
  showHeader: boolean;
  terminalLabelById: ReadonlyMap<string, string>;
  closeShortcutLabel: string | undefined;
  canOperateTerminal: boolean;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
}) {
  const isGroupActive = terminalGroup.terminalIds.includes(activeTerminalId);
  const groupActiveTerminalId = isGroupActive
    ? activeTerminalId
    : (terminalGroup.terminalIds[0] ?? activeTerminalId);
  const terminalCount = terminalGroup.terminalIds.length;
  const isSplitGroup = terminalCount > 1;
  const groupLabel = !isSplitGroup
    ? "Single"
    : terminalGroup.splitDirection === "vertical"
      ? "Stacked"
      : "Side by side";
  const GroupIcon = !isSplitGroup
    ? Square
    : terminalGroup.splitDirection === "vertical"
      ? SquareSplitVertical
      : SquareSplitHorizontal;

  return (
    <div className="pb-0.5">
      {showHeader && (
        <button
          type="button"
          className={`flex h-[22px] w-full cursor-pointer items-center gap-1 rounded px-1.5 text-2xs ${
            isGroupActive
              ? "bg-accent/50 text-foreground"
              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          }`}
          onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
        >
          <GroupIcon className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{groupLabel}</span>
          <span className="text-muted-foreground/70 text-3xs tabular-nums">{terminalCount}</span>
        </button>
      )}

      <div className="flex flex-col gap-0.5">
        {terminalGroup.terminalIds.map((terminalId) => {
          const isActive = terminalId === activeTerminalId;
          const terminalLabel = terminalLabelById.get(terminalId) ?? "Terminal";
          const closeTerminalLabel = `Close ${terminalLabel}${
            isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""
          }`;
          return (
            <div
              key={terminalId}
              className={cn(
                "group/tab flex h-6 w-full items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {canOperateTerminal ? (
                <PanelTabCloseButton
                  label={closeTerminalLabel}
                  onClick={() => onCloseTerminal(terminalId)}
                  tooltip={closeTerminalLabel}
                >
                  <TerminalSquare className="size-3 shrink-0" />
                </PanelTabCloseButton>
              ) : (
                <TerminalSquare className="size-3 shrink-0" />
              )}
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
                onClick={() => onActiveTerminalChange(terminalId)}
              >
                <span className="truncate">{terminalLabel}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ThreadTerminalDrawer({
  mode = "drawer",
  threadRef,
  threadId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible = true,
  height,
  composerHeight = 0,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
  keybindings,
  terminalLabelsById,
  terminalLaunchLocationsById,
}: ThreadTerminalDrawerProps) {
  const canOperateTerminal = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const terminalArea = workspaceAreaProps("terminal", 5, "Terminal");
  const isPanel = mode === "panel";
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const drawerRef = useRef<HTMLElement | null>(null);
  const [drawerLayout, setDrawerLayout] = useState(() => readDrawerLayout(null));
  const maxDrawerHeight = resolveTerminalDrawerMaxHeight({ ...drawerLayout, composerHeight });
  const drawerHeight = clampDrawerHeight(height, maxDrawerHeight);
  // A drag only writes the drawer's style; the store hears the height once, at
  // pointerup. The custom property outranks the rendered height while it is set.
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    height: number;
    drawer: HTMLElement | null;
  } | null>(null);

  const normalizedTerminalIds = (() => {
    const normalizedIds: string[] = [];
    const seen = new Set<string>();
    for (const id of terminalIds) {
      const trimmedId = id.trim();
      if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
      seen.add(trimmedId);
      normalizedIds.push(trimmedId);
    }
    return normalizedIds;
  })();
  const resolvedTerminalGroups = (() => {
    if (normalizedTerminalIds.length === 0) {
      return [];
    }
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds: string[] = [];
      const seenGroupTerminalIds = new Set<string>();
      for (const id of terminalGroup.terminalIds) {
        const terminalId = id.trim();
        if (terminalId.length === 0) continue;
        if (seenGroupTerminalIds.has(terminalId)) continue;
        seenGroupTerminalIds.add(terminalId);
        if (!validTerminalIdSet.has(terminalId)) continue;
        if (assignedTerminalIds.has(terminalId)) continue;
        nextTerminalIds.push(terminalId);
      }
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? normalizedTerminalIds[0] ?? ""}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
        ...(terminalGroup.splitDirection === "vertical"
          ? { splitDirection: "vertical" as const }
          : {}),
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    const terminalOrderIndex = new Map(
      normalizedTerminalIds.map((id, index) => [id, index] as const),
    );
    nextGroups.sort((left, right) => {
      const rank = (ids: readonly string[]) =>
        Math.min(...ids.map((id) => terminalOrderIndex.get(id) ?? Number.POSITIVE_INFINITY));
      return rank(left.terminalIds) - rank(right.terminalIds);
    });

    return nextGroups;
  })();
  const groupIndexByTerminalId = (() => {
    const next = new Map<string, number>();
    for (const [index, terminalGroup] of resolvedTerminalGroups.entries()) {
      for (const terminalId of terminalGroup.terminalIds) next.set(terminalId, index);
    }
    return next;
  })();
  const terminalLabelById = (() => {
    const next = new Map<string, string>();
    for (const terminalId of normalizedTerminalIds) {
      next.set(terminalId, terminalLabelsById?.get(terminalId) ?? getTerminalLabel(terminalId));
    }
    return next;
  })();

  const resolvedActiveTerminalId =
    normalizedTerminalIds.length === 0
      ? ""
      : normalizedTerminalIds.includes(activeTerminalId)
        ? activeTerminalId
        : (normalizedTerminalIds[0] ?? "");

  const groupIndexById = resolvedTerminalGroups.findIndex(
    (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
  );
  const resolvedActiveGroupIndex =
    groupIndexById >= 0
      ? groupIndexById
      : (groupIndexByTerminalId.get(resolvedActiveTerminalId) ?? 0);

  const visibleTerminalIds =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ??
    (normalizedTerminalIds.length > 0 ? [resolvedActiveTerminalId] : []);
  const splitDirection =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.splitDirection ?? "horizontal";
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const resolveTerminalLaunchLocation = (terminalId: string): TerminalLaunchLocation =>
    terminalLaunchLocationsById?.get(terminalId) ?? {
      cwd,
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(runtimeEnv ? { runtimeEnv } : {}),
    };
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Horizontally (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal Horizontally (${splitShortcutLabel})`
      : "Split Terminal Horizontally";
  const splitTerminalVerticalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Vertically (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitVerticalShortcutLabel
      ? `Split Terminal Vertically (${splitVerticalShortcutLabel})`
      : "Split Terminal Vertically";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = () => {
    if (!canOperateTerminal || hasReachedSplitLimit) return;
    onSplitTerminal();
  };
  const onSplitTerminalVerticalAction = () => {
    if (!canOperateTerminal || hasReachedSplitLimit) return;
    onSplitTerminalVertical();
  };
  const onNewTerminalAction = () => {
    if (!canOperateTerminal) return;
    onNewTerminal();
  };
  const confirmCloseTerminal = (terminalId: string) => {
    if (!canOperateTerminal) return;
    const label = terminalLabelById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)) {
        onCloseTerminal(terminalId, threadRef);
      }
    });
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeight,
      height: drawerHeight,
      drawer: event.currentTarget.parentElement,
    };
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
      maxDrawerHeight,
    );
    if (clampedHeight === resizeState.height) {
      return;
    }
    resizeState.height = clampedHeight;
    resizeState.drawer?.style.setProperty(DRAG_HEIGHT_PROPERTY, `${clampedHeight}px`);
  };

  const handleResizePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    resizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeState.drawer?.style.removeProperty(DRAG_HEIGHT_PROPERTY);
    // A drag that ends where it started keeps the stored preference, which may
    // be taller than the capped height the drag started from.
    if (resizeState.height === resizeState.startHeight || resizeState.height === height) return;
    onHeightChange(resizeState.height);
  };

  const drawerLayoutRef = useRef(drawerLayout);
  const updateDrawerLayout = useEffectEvent(
    (column: HTMLElement | null, source: "window" | "column") => {
      const layout = readDrawerLayout(column);
      const previous = drawerLayoutRef.current;
      const heightBudgetChanged =
        layout.viewportHeight !== previous.viewportHeight ||
        layout.chatColumnHeight !== previous.chatColumnHeight ||
        layout.headerHeight !== previous.headerHeight;
      // The column also reports width-only changes, such as every frame of a
      // right panel drag; the surface refits itself for those.
      if (!heightBudgetChanged && source === "column") return;
      drawerLayoutRef.current = layout;
      const resizeState = resizeStateRef.current;
      if (resizeState) {
        const liveHeight = clampDrawerHeight(
          resizeState.height,
          resolveTerminalDrawerMaxHeight({ ...layout, composerHeight }),
        );
        if (liveHeight !== resizeState.height) {
          resizeState.height = liveHeight;
          resizeState.drawer?.style.setProperty(DRAG_HEIGHT_PROPERTY, `${liveHeight}px`);
        }
      }
      if (heightBudgetChanged) setDrawerLayout(layout);
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the drawer before visible paint and observes window and chat column resizes while visible
  useLayoutEffect(() => {
    if (!visible) {
      return;
    }
    // The column and window may have resized while the drawer was hidden and
    // not listening, so measure before the first visible paint.
    const column = isPanel ? null : chatColumnOf(drawerRef.current);
    const onWindowResize = () => updateDrawerLayout(column, "window");
    onWindowResize();
    const header = column?.querySelector<HTMLElement>("[data-chat-header]");
    const stopObserving = column
      ? observeResize(header ? [column, header] : column, () =>
          updateDrawerLayout(column, "column"),
        )
      : undefined;
    window.addEventListener("resize", onWindowResize);
    return () => {
      stopObserving?.();
      window.removeEventListener("resize", onWindowResize);
    };
  }, [isPanel, visible]);

  if (normalizedTerminalIds.length === 0) {
    return (
      <aside
        ref={drawerRef}
        {...(!isPanel && visible ? terminalArea : {})}
        data-thread-terminal-drawer
        data-terminal-owner={isPanel ? "right-panel" : "drawer"}
        className={cn(
          "relative flex min-w-0 flex-col overflow-hidden bg-background",
          isPanel ? "h-full flex-1" : "z-45 shrink-0 border-t border-border/80",
        )}
        style={isPanel ? undefined : { height: `var(${DRAG_HEIGHT_PROPERTY}, ${drawerHeight}px)` }}
      >
        {!isPanel ? (
          <div
            className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
            onLostPointerCapture={handleResizePointerEnd}
          />
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-muted-foreground">
          <p>No terminal sessions for this thread yet.</p>
          <Button
            size="xs"
            variant="outline"
            onClick={onNewTerminalAction}
            disabled={!canOperateTerminal}
          >
            {newTerminalActionLabel}
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={drawerRef}
      {...(!isPanel && visible ? terminalArea : {})}
      data-thread-terminal-drawer
      data-terminal-owner={isPanel ? "right-panel" : "drawer"}
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden bg-background",
        isPanel ? "h-full flex-1" : "z-45 shrink-0 border-t border-border/80",
      )}
      style={isPanel ? undefined : { height: `var(${DRAG_HEIGHT_PROPERTY}, ${drawerHeight}px)` }}
    >
      {!isPanel ? (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
          onLostPointerCapture={handleResizePointerEnd}
        />
      ) : null}

      {!hasTerminalSidebar && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background shadow-xs">
            <TerminalActionButton
              disabled={!canOperateTerminal}
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalAction}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontal className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              disabled={!canOperateTerminal}
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalVerticalAction}
              label={splitTerminalVerticalActionLabel}
            >
              <SquareSplitVertical className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              disabled={!canOperateTerminal}
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={onNewTerminalAction}
              label={newTerminalActionLabel}
            >
              <Plus className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              disabled={!canOperateTerminal}
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => confirmCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div
          className={cn(
            "flex h-full min-h-0 bg-(--terminal-background)",
            hasTerminalSidebar && "gap-1.5",
          )}
        >
          <div className="min-w-0 flex-1">
            <TerminalSplitPanes
              terminalIds={visibleTerminalIds}
              splitDirection={splitDirection}
              activeTerminalId={resolvedActiveTerminalId}
              terminalLabelById={terminalLabelById}
              resolveLaunchLocation={resolveTerminalLaunchLocation}
              onActiveTerminalChange={onActiveTerminalChange}
              onCloseTerminal={onCloseTerminal}
              advancedTypography={advancedTypography}
              threadRef={threadRef}
              threadId={threadId}
              onAddTerminalContext={onAddTerminalContext}
              visible={visible}
              keybindings={keybindings}
            />
          </div>

          {hasTerminalSidebar && (
            <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <div className="inline-flex h-full items-stretch">
                  <TerminalActionButton
                    disabled={!canOperateTerminal}
                    className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalAction}
                    label={splitTerminalActionLabel}
                  >
                    <SquareSplitHorizontal className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    disabled={!canOperateTerminal}
                    className={`inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalVerticalAction}
                    label={splitTerminalVerticalActionLabel}
                  >
                    <SquareSplitVertical className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    disabled={!canOperateTerminal}
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={onNewTerminalAction}
                    label={newTerminalActionLabel}
                  >
                    <Plus className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    disabled={!canOperateTerminal}
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={() => confirmCloseTerminal(resolvedActiveTerminalId)}
                    label={closeTerminalActionLabel}
                  >
                    <Trash2 className="size-3.25" />
                  </TerminalActionButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup) => (
                  <TerminalSidebarGroup
                    key={terminalGroup.id}
                    terminalGroup={terminalGroup}
                    activeTerminalId={resolvedActiveTerminalId}
                    showHeader={showGroupHeaders}
                    terminalLabelById={terminalLabelById}
                    closeShortcutLabel={closeShortcutLabel}
                    canOperateTerminal={canOperateTerminal}
                    onActiveTerminalChange={onActiveTerminalChange}
                    onCloseTerminal={confirmCloseTerminal}
                  />
                ))}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}
