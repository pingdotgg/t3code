import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  HistoryIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useProject, useThread, useThreadShellsForProjectRefs } from "../state/entities";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveContextStripLabelsCompact,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveEffectiveEnvMode,
  resolveLockedWorkspaceLabel,
  resolvePreviousWorktreeLabel,
  resolvePreviousWorktreeSeed,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Separator } from "./ui/separator";
import { ComposerSurface } from "./chat/ComposerSurface";
import { composerFloatingLayerProps } from "./chat/composerEventScope";
import { measureRestingComposerControls } from "./chat/restingComposerControlsMeasurement";
import { resolveRestingComposerControlsNaturalWidth } from "./composerFooterLayout";
import { cn } from "~/lib/utils";

interface BranchToolbarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  showGitControls: boolean;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  effectiveEnvModeOverride?: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  composerControlsHostRef?: (element: HTMLDivElement | null) => void;
  contextStripVisible?: boolean;
}

interface MobileRunContextSelectorProps {
  envLocked: boolean;
  envModeLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  showEnvironmentIndicator: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel: string | null;
  onUsePreviousWorktree: () => void;
}

const MobileRunContextSelector = memo(function MobileRunContextSelector({
  envLocked,
  envModeLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  showEnvironmentIndicator,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  onUsePreviousWorktree,
}: MobileRunContextSelectorProps) {
  const activeEnvironment = useMemo(
    () => availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null,
    [availableEnvironments, environmentId],
  );
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel = envModeLocked
    ? resolveLockedWorkspaceLabel(activeWorktreePath)
    : effectiveEnvMode === "worktree"
      ? resolveEnvModeLabel("worktree")
      : resolveCurrentWorkspaceLabel(activeWorktreePath);
  const isLocked = envLocked || envModeLocked;
  const icon = showEnvironmentIndicator ? (
    // Button's base styles apply `-mx-0.5` to descendant SVGs, which eats 4px
    // out of whatever gap we set. mx-0! cancels that so gap-0.5 reads as 2px.
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <EnvironmentMachineIcon
        kind={activeEnvironment?.machine ?? "server"}
        className="size-3 shrink-0 mx-0!"
      />
      <WorkspaceIcon className="size-3 shrink-0 mx-0!" />
    </span>
  ) : (
    <WorkspaceIcon className="size-3 shrink-0" />
  );
  const triggerContent = (
    <>
      {icon}
      <span
        data-composer-label
        className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
      >
        <span
          data-composer-label-motion
          className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
        >
          {showEnvironmentIndicator ? (activeEnvironment?.label ?? "Run on") : workspaceLabel}
        </span>
      </span>
    </>
  );

  if (isLocked) {
    return (
      <span
        className="inline-flex h-7 min-w-0 max-w-[48%] flex-initial items-center justify-start gap-1 rounded-md border border-transparent px-[calc(--spacing(2)-1px)] font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" />}
        className="min-w-0 max-w-[48%] flex-initial justify-start font-normal text-muted-foreground/70 text-xs! hover:text-foreground/80"
        data-composer-context-control
      >
        {triggerContent}
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-64" {...composerFloatingLayerProps}>
        {showEnvironmentPicker && availableEnvironments && onEnvironmentChange ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Run on</MenuGroupLabel>
              <MenuRadioGroup
                value={environmentId}
                onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
              >
                {availableEnvironments.map((env) => (
                  <MenuRadioItem
                    key={env.environmentId}
                    disabled={envLocked}
                    value={env.environmentId}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                      <span className="min-w-0 truncate">{env.label}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => {
              if (value === "previous-worktree") {
                onUsePreviousWorktree();
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={envModeLocked} value="local">
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <span className="min-w-0 truncate">
                  {resolveCurrentWorkspaceLabel(activeWorktreePath)}
                </span>
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree">
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
            {previousWorktreeLabel ? (
              <MenuRadioItem disabled={envModeLocked} value="previous-worktree">
                <span className="flex min-w-0 items-center gap-1.5">
                  <HistoryIcon className="size-3" />
                  <span className="min-w-0 truncate">{previousWorktreeLabel}</span>
                </span>
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

/**
 * Collapse the strip's labels to icons only when the text no longer fits.
 *
 * Hidden labels stay measurable because their inner text keeps its natural
 * width while the outer layout box collapses. This lets every pass recompute
 * the expanded width without remembered values that could go stale or latch
 * the strip compact. A small hysteresis keeps the boundary from flapping.
 */
const COMPOSER_CONTEXT_MOTION_DURATION_MS = 180;
const COMPOSER_CONTEXT_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_CONTEXT_CONTROL_SELECTOR = "[data-composer-context-control]";

function useLabelsOverflow(element: HTMLDivElement | null): boolean {
  const [overflows, setOverflows] = useState(false);
  const pendingControlRectsRef = useRef<Map<HTMLElement, DOMRect> | null>(null);
  const controlAnimationsRef = useRef(new Map<HTMLElement, Animation>());
  // A render-synced mirror instead of useEffectEvent: the compiler memoizes
  // the event callback, which left observers reading the first render's null
  // element forever.
  const stateRef = useRef({ element, overflows });
  stateRef.current = { element, overflows };

  const measure = useCallback(() => {
    const { element: current, overflows: compact } = stateRef.current;
    if (!current) return;
    const available = current.clientWidth;
    if (available === 0) return;
    // flex-1 stretches the groups to fill the strip, so their own boxes always
    // measure "full". Sum the laid-out content instead, skipping hidden form
    // artifacts and other out-of-flow nodes.
    const contentWidth = (parent: Element): number => {
      const gap = Number.parseFloat(getComputedStyle(parent).columnGap) || 0;
      let width = 0;
      let counted = 0;
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.offsetWidth === 0) continue;
        const style = getComputedStyle(child);
        const position = style.position;
        if (position === "absolute" || position === "fixed") continue;
        width +=
          child.offsetWidth +
          (Number.parseFloat(style.marginInlineStart) || 0) +
          (Number.parseFloat(style.marginInlineEnd) || 0);
        counted += 1;
      }
      return width + gap * Math.max(0, counted - 1);
    };
    const stripGap = Number.parseFloat(getComputedStyle(current).columnGap) || 0;
    let needed = 0;
    let groups = 0;
    for (const child of current.children) {
      if (!(child instanceof HTMLElement)) continue;
      // The host itself flexes into all remaining room. Reserve the natural
      // width of the controls inside it, blocks in overflow included, so Git
      // labels compact before squeezing out the model picker. Reserving only
      // the visible controls would let the labels expand into room the
      // composer just freed, shrink the host, and hide the controls again.
      const hostedControls = child.matches('[data-chat-resting-composer-controls-host="true"]')
        ? child.querySelector<HTMLElement>('[data-chat-composer-resting-controls="true"]')
        : null;
      const hostedMeasurement = hostedControls
        ? measureRestingComposerControls(hostedControls)
        : null;
      const width = hostedMeasurement
        ? resolveRestingComposerControlsNaturalWidth(hostedMeasurement)
        : contentWidth(hostedControls ?? child);
      if (width <= 1) continue;
      groups += 1;
      needed += width;
    }
    needed += stripGap * Math.max(0, groups - 1);
    for (const label of current.querySelectorAll<HTMLElement>("[data-composer-label]")) {
      // The clipping can happen below the marker (SelectValue truncates
      // internally), where the outer span's scrollWidth matches its clipped
      // box. The text's real width is the largest scrollWidth in the subtree.
      let textWidth = label.scrollWidth;
      for (const inner of label.querySelectorAll<HTMLElement>("*")) {
        textWidth = Math.max(textWidth, inner.scrollWidth);
      }
      if (compact) {
        // Compact: the label is squeezed to zero width but keeps reporting
        // the full width it would need when expanded.
        needed += textWidth;
      } else {
        // Expanded: the label is in flow; only the clipped remainder is
        // missing from the content sum.
        needed += Math.max(0, textWidth - label.clientWidth);
      }
    }
    const nextOverflows = resolveContextStripLabelsCompact({
      compact,
      neededWidth: needed,
      availableWidth: available,
    });
    if (nextOverflows !== compact) {
      pendingControlRectsRef.current = new Map(
        Array.from(current.querySelectorAll<HTMLElement>(COMPOSER_CONTEXT_CONTROL_SELECTOR)).map(
          (control) => [control, control.getBoundingClientRect()],
        ),
      );
    }
    setOverflows(nextOverflows);
  }, []);

  useLayoutEffect(() => {
    const previousRects = pendingControlRectsRef.current;
    if (!previousRects) return;
    pendingControlRectsRef.current = null;

    for (const animation of controlAnimationsRef.current.values()) {
      animation.cancel();
    }
    controlAnimationsRef.current.clear();

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    for (const [control, previousRect] of previousRects) {
      if (!control.isConnected) continue;
      const nextRect = control.getBoundingClientRect();
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

      const animation = control.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        {
          duration: COMPOSER_CONTEXT_MOTION_DURATION_MS,
          easing: COMPOSER_CONTEXT_MOTION_EASING,
          fill: "backwards",
        },
      );
      controlAnimationsRef.current.set(control, animation);
      animation.addEventListener(
        "finish",
        () => {
          if (controlAnimationsRef.current.get(control) === animation) {
            controlAnimationsRef.current.delete(control);
          }
        },
        { once: true },
      );
    }
  }, [overflows]);

  useEffect(
    () => () => {
      for (const animation of controlAnimationsRef.current.values()) {
        animation.cancel();
      }
    },
    [],
  );

  // Label widths can change without the strip box moving (font family or
  // size preferences), so re-measure on every render as well as on resize
  // and font loads.
  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [element, measure]);

  return overflows;
}

export const BranchToolbar = memo(function BranchToolbar({
  environmentId,
  threadId,
  showGitControls,
  draftId,
  onEnvModeChange,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
  composerControlsHostRef,
  contextStripVisible = true,
}: BranchToolbarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);
  const hasActiveThread = serverThread !== null || draftThread !== null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread: serverThread !== null,
      draftThreadEnvMode: draftThread?.envMode,
    });
  const envModeLocked = envLocked || (serverThread !== null && activeWorktreePath !== null);

  // "Previous worktree" hops a draft into the most recently active worktree
  // of this project — the "keep going where I just was" follow-up flow. Only
  // drafts can hop; started server threads have their workspace pinned.
  const canUsePreviousWorktree = draftThread !== null && serverThread === null && !envModeLocked;
  const projectRefsForWorktreeLookup = useMemo(
    () => (canUsePreviousWorktree && activeProjectRef ? [activeProjectRef] : []),
    [canUsePreviousWorktree, activeProjectRef],
  );
  const projectThreads = useThreadShellsForProjectRefs(projectRefsForWorktreeLookup);
  const previousWorktreeSeed = useMemo(
    () =>
      canUsePreviousWorktree
        ? resolvePreviousWorktreeSeed({
            threads: projectThreads,
            currentWorktreePath: activeWorktreePath,
          })
        : null,
    [activeWorktreePath, canUsePreviousWorktree, projectThreads],
  );
  const previousWorktreeLabel = previousWorktreeSeed
    ? resolvePreviousWorktreeLabel(previousWorktreeSeed)
    : null;
  const onUsePreviousWorktree = useCallback(() => {
    if (!previousWorktreeSeed || !activeProjectRef) return;
    // Same shape the branch selector writes when picking a branch that
    // already lives in a worktree: point the draft at the existing tree.
    setDraftThreadContext(draftId ?? threadRef, {
      branch: previousWorktreeSeed.branch,
      worktreePath: previousWorktreeSeed.worktreePath,
      envMode: "worktree",
      projectRef: activeProjectRef,
    });
  }, [activeProjectRef, draftId, previousWorktreeSeed, setDraftThreadContext, threadRef]);

  const showEnvironmentPicker = Boolean(
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange,
  );
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const showEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: showEnvironmentPicker,
  });
  const [stripElement, setStripElement] = useState<HTMLDivElement | null>(null);
  const labelsOverflow = useLabelsOverflow(stripElement);

  if (!hasActiveThread || !activeProject) return null;

  return (
    <ComposerSurface.ContextStrip
      ref={setStripElement}
      data-compact={labelsOverflow ? "" : undefined}
      className={cn(
        "gap-1 text-xs font-normal text-muted-foreground/70",
        // A non-Git strip with no visible composer controls should occupy no
        // space, but its host must retain a prospective width so controls can
        // become visible again when the chat view grows.
        !contextStripVisible && "pointer-events-none invisible absolute inset-x-0 top-full",
      )}
    >
      {showGitControls ? (
        <div className="contents @3xl/composer-surface:hidden">
          <MobileRunContextSelector
            envLocked={envLocked}
            envModeLocked={envModeLocked}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            showEnvironmentPicker={showEnvironmentPicker}
            showEnvironmentIndicator={showEnvironmentIndicator}
            onEnvironmentChange={onEnvironmentChange}
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            onEnvModeChange={onEnvModeChange}
            previousWorktreeLabel={previousWorktreeLabel}
            onUsePreviousWorktree={onUsePreviousWorktree}
          />
        </div>
      ) : null}
      {showGitControls || showEnvironmentIndicator ? (
        <div
          className={cn(
            "min-h-7 min-w-10 items-center gap-1 sm:min-h-6",
            showGitControls ? "hidden @3xl/composer-surface:flex" : "flex",
            composerControlsHostRef ? "shrink" : "flex-1",
          )}
        >
          {showEnvironmentIndicator && availableEnvironments && (
            <>
              <BranchToolbarEnvironmentSelector
                envLocked={envLocked}
                environmentId={environmentId}
                availableEnvironments={availableEnvironments}
                {...(showEnvironmentPicker && onEnvironmentChange ? { onEnvironmentChange } : {})}
              />
              {showGitControls ? (
                <Separator
                  orientation="vertical"
                  className="mx-0.5 h-3.5!"
                  data-composer-context-control
                />
              ) : null}
            </>
          )}
          {showGitControls ? (
            <BranchToolbarEnvModeSelector
              envLocked={envModeLocked}
              effectiveEnvMode={effectiveEnvMode}
              activeWorktreePath={activeWorktreePath}
              onEnvModeChange={onEnvModeChange}
              previousWorktreeLabel={previousWorktreeLabel}
              onUsePreviousWorktree={onUsePreviousWorktree}
            />
          ) : null}
        </div>
      ) : null}

      {composerControlsHostRef ? (
        // The host takes whatever the workspace and branch controls leave
        // over, in both strip layouts, so a collapsed composer can show its
        // model and mode controls wherever they fit.
        <div
          ref={composerControlsHostRef}
          data-composer-context-control
          data-chat-resting-composer-controls-host="true"
          className="flex min-w-0 flex-1 items-center justify-start overflow-x-clip overflow-y-visible"
        />
      ) : null}

      {showGitControls ? (
        <BranchToolbarBranchSelector
          className="min-w-0 flex-initial justify-end @3xl/composer-surface:ml-auto"
          environmentId={environmentId}
          threadId={threadId}
          {...(draftId ? { draftId } : {})}
          envLocked={envLocked}
          {...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {})}
          {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
          {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={onStartFromOriginChange}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      ) : null}
    </ComposerSurface.ContextStrip>
  );
});
