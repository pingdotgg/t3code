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
import type { TerminalLaunchLocation, ThreadTerminalDrawerProps } from "./ThreadTerminalDrawer";
import { DRAG_HEIGHT_PROPERTY, TerminalActionButton, TerminalSplitPanes, chatColumnOf, clampDrawerHeight, readDrawerLayout, resolveTerminalDrawerMaxHeight } from "./ThreadTerminalDrawer";

export function TerminalSidebarGroup({
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

