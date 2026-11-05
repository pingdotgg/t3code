import { ComposerContextLabel } from "./ComposerContextLabel";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { PlusIcon, ScaleIcon } from "lucide-react";
import { type Ref, type ReactNode, memo, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";

import type { DraftId } from "../composerDraftStore";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useProject } from "../state/entities";
import {
  ADD_TO_MACHINE_LABEL_CLASS,
  type EnvironmentOption,
  resolveContextStripLabelsCompact,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import {
  BranchToolbarBranchSelector,
  type BranchToolbarBranchSelectorHandle,
} from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
import { type AddProjectTarget, useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { ComposerControl } from "./chat/ComposerControl";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerSurface } from "./chat/ComposerSurface";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";

export interface BranchToolbarHandle {
  openBranchPicker: () => void;
}

interface BranchToolbarProps {
  layout?: "composer" | "panel";
  panelSection?: "all" | "workspace" | "branch";
  ref?: Ref<BranchToolbarHandle>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  showGitControls: boolean;
  draftId?: DraftId;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  /** Shown at the end of the composer strip, such as the new thread's permissions. */
  trailing?: ReactNode;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

interface RunContextSelectorProps {
  displayMode?: "toolbar" | "panel";
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  addTargets: readonly AddProjectTarget[];
  onAddToMachine: (environmentId: EnvironmentId) => void;
}

const RunContextSelector = memo(function RunContextSelector({
  displayMode = "toolbar",
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  onEnvironmentChange,
  addTargets,
  onAddToMachine,
}: RunContextSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const environmentLabel = autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on";
  const isPanel = displayMode === "panel";
  const environmentIcon = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        {autoEnvironmentLabel ? (
          <ScaleIcon
            className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"}
            aria-hidden="true"
          />
        ) : (
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            // Wide machine glyphs need a little more box to match the square row icons.
            className={
              isPanel ? cn(THREAD_DETAILS_PANEL_ICON_CLASS, "-mx-px size-4.5") : "size-3 shrink-0"
            }
          />
        )}
      </TooltipTrigger>
      <TooltipPopup>{environmentLabel}</TooltipPopup>
    </Tooltip>
  );
  const triggerContent = (
    <>
      {environmentIcon}
      <ComposerContextLabel displayMode={displayMode}>{environmentLabel}</ComposerContextLabel>
    </>
  );

  if (envLocked) {
    return (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 max-w-[48%] flex-initial items-center justify-start gap-1 rounded-md border border-transparent px-1.75 font-normal text-foreground/70 text-sm sm:h-6 sm:text-xs dark:text-muted-foreground",
          isPanel && "max-w-full",
          isPanel && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        aria-label={isPanel ? `Run context: ${environmentLabel}` : undefined}
        data-composer-context-control
      >
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={isPanel ? <ThreadDetailsControl part="select" /> : <ComposerControl size="xs" />}
        className={isPanel ? undefined : "min-w-0 max-w-[48%] flex-initial justify-start"}
        aria-label={isPanel ? `Run context: ${environmentLabel}` : undefined}
        data-composer-context-control
        data-composer-shortcut={showEnvironmentPicker ? "composer.host" : undefined}
      >
        {triggerContent}
      </MenuTrigger>
      <MenuPopup
        align="start"
        side={isPanel ? "bottom" : "top"}
        className={isPanel ? "w-(--anchor-width)" : undefined}
        {...(!isPanel ? composerFloatingLayerProps : {})}
      >
        {availableEnvironments &&
        ((showEnvironmentPicker && onEnvironmentChange) || addTargets.length > 0) ? (
          <MenuGroup>
            <MenuGroupLabel>Run on</MenuGroupLabel>
            <MenuRadioGroup
              value={autoEnvironmentLabel ? "auto" : environmentId}
              onValueChange={(value) =>
                value === "auto"
                  ? onAutoEnvironment?.()
                  : onEnvironmentChange?.(value as EnvironmentId)
              }
            >
              {onAutoEnvironment && (
                <MenuRadioItem
                  value="auto"
                  disabled={envLocked}
                  closeOnClick
                  onClick={() => {
                    if (autoEnvironmentLabel) onAutoEnvironment?.();
                  }}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ScaleIcon className="size-3" aria-hidden="true" />
                    <span className="min-w-0 truncate">
                      {autoEnvironmentLabel ?? "Auto balance"}
                    </span>
                  </span>
                </MenuRadioItem>
              )}
              {availableEnvironments.map((env) => (
                <MenuRadioItem
                  key={env.environmentId}
                  disabled={
                    envLocked || (!onEnvironmentChange && env.environmentId !== environmentId)
                  }
                  value={env.environmentId}
                  closeOnClick
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                    <span className="min-w-0 truncate">{env.label}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            {addTargets.length > 0 ? (
              <MenuSub>
                <MenuSubTrigger>
                  <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                    <PlusIcon className="size-3" />
                    <span className="min-w-0 truncate">Add to another machine</span>
                  </span>
                </MenuSubTrigger>
                <MenuSubPopup {...(!isPanel ? composerFloatingLayerProps : {})}>
                  {addTargets.map((target) => (
                    <MenuItem
                      key={target.environmentId}
                      onClick={() => onAddToMachine(target.environmentId)}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <EnvironmentMachineIcon kind={target.machine} className="size-3" />
                        <span className="min-w-0 truncate">{target.label}</span>
                      </span>
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            ) : null}
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

const COMPOSER_CONTEXT_MOTION_DURATION_MS = 180;
const COMPOSER_CONTEXT_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_CONTEXT_LABEL_SELECTOR = "[data-composer-label]";

/** A hidden or squeezed label's scrollWidth loses its tail, causing label/icon flapping. */
function labelTextWidth(label: HTMLElement, range: Range): number {
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  let width = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    width += range.getBoundingClientRect().width;
  }
  const motion = label.querySelector<HTMLElement>("[data-composer-label-motion]");
  const maxWidth = motion ? Number.parseFloat(getComputedStyle(motion).maxWidth) : Number.NaN;
  return Number.isFinite(maxWidth) ? Math.min(width, maxWidth) : width;
}

function animateLabelWidths(
  previousRects: ReadonlyMap<HTMLElement, DOMRect>,
  animations: Map<HTMLElement, Animation>,
) {
  for (const animation of animations.values()) animation.cancel();
  animations.clear();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  for (const [label, previousRect] of previousRects) {
    if (!label.isConnected) continue;
    const nextWidth = label.getBoundingClientRect().width;
    if (Math.abs(previousRect.width - nextWidth) < 0.5) continue;

    const animation = label.animate(
      [
        { width: `${previousRect.width}px`, maxWidth: `${previousRect.width}px` },
        { width: `${nextWidth}px`, maxWidth: `${nextWidth}px` },
      ],
      {
        duration: COMPOSER_CONTEXT_MOTION_DURATION_MS,
        easing: COMPOSER_CONTEXT_MOTION_EASING,
        fill: "backwards",
      },
    );
    animations.set(label, animation);
    animation.addEventListener(
      "finish",
      () => {
        if (animations.get(label) === animation) animations.delete(label);
      },
      { once: true },
    );
  }
}

/**
 * Whether the strip's labels must collapse to icons. The strip is measured when
 * it, a control group or a hosted control resizes, when its text or children
 * change, and when fonts load, which covers everything the widths depend on.
 */
function useLabelsOverflow(): readonly [
  attach: (element: HTMLDivElement | null) => (() => void) | undefined,
  overflows: boolean,
] {
  const [overflows, setOverflows] = useState(false);

  const attach = (current: HTMLDivElement | null) => {
    if (!current) return;
    const labelAnimations = new Map<HTMLElement, Animation>();

    const measure = () => {
      // The committed attribute, not render state, so a stale closure cannot misread it.
      const compact = current.hasAttribute("data-compact");
      const stripWidth = current.clientWidth;
      if (stripWidth === 0) return;
      const stripStyle = getComputedStyle(current);
      const available =
        stripWidth -
        (Number.parseFloat(stripStyle.paddingInlineStart) || 0) -
        (Number.parseFloat(stripStyle.paddingInlineEnd) || 0);
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
      const stripGap = Number.parseFloat(stripStyle.columnGap) || 0;
      let needed = 0;
      let groups = 0;
      for (const child of current.children) {
        if (!(child instanceof HTMLElement)) continue;
        const width = contentWidth(child);
        if (width <= 1) continue;
        groups += 1;
        needed += width;
      }
      needed += stripGap * Math.max(0, groups - 1);
      const range = document.createRange();
      for (const label of current.querySelectorAll<HTMLElement>("[data-composer-label]")) {
        needed += Math.max(0, labelTextWidth(label, range) - label.getBoundingClientRect().width);
      }
      const nextOverflows = resolveContextStripLabelsCompact({
        compact,
        neededWidth: needed,
        availableWidth: available,
      });
      if (nextOverflows === compact) return;
      const previousRects = new Map(
        Array.from(current.querySelectorAll<HTMLElement>(COMPOSER_CONTEXT_LABEL_SELECTOR)).map(
          (label) => [label, label.getBoundingClientRect()] as const,
        ),
      );
      flushSync(() => setOverflows(nextOverflows));
      animateLabelWidths(previousRects, labelAnimations);
    };

    let stopResize = () => {};
    const observeSizes = () => {
      stopResize();
      stopResize = observeResize(
        [
          current,
          ...Array.from(current.children),
          ...Array.from(current.querySelectorAll(COMPOSER_CONTEXT_LABEL_SELECTOR)),
        ],
        measure,
      );
    };
    observeSizes();
    // Text and control changes alter natural widths without resizing a hidden
    // or squeezed label, so they re-measure too. Only added or removed elements
    // can change the observed set; re-subscribing delivers a measure itself.
    const mutations = new MutationObserver((records) => {
      const elementsChanged = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element),
      );
      if (elementsChanged) observeSizes();
      else measure();
    });
    mutations.observe(current, { childList: true, characterData: true, subtree: true });
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      stopResize();
      mutations.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
      for (const animation of labelAnimations.values()) animation.cancel();
    };
  };

  return [attach, overflows] as const;
}

export const BranchToolbar = memo(function BranchToolbar({
  layout = "composer",
  panelSection = "all",
  ref,
  environmentId,
  threadId,
  projectId,
  showGitControls,
  draftId,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
  trailing,
}: BranchToolbarProps) {
  const branchSelectorRef = useRef<BranchToolbarBranchSelectorHandle>(null);
  // The composer retains resolved thread details while bootstrap cleanup can remove its shell.
  const activeProjectRef = scopeProjectRef(environmentId, projectId);
  const activeProject = useProject(activeProjectRef);

  useImperativeHandle(ref, () => ({
    openBranchPicker: () => branchSelectorRef.current?.open(),
  }));

  const addTargets = useAddProjectTargets(activeProject, availableEnvironments);
  const onAddToMachine = (targetEnvironmentId: EnvironmentId | null) =>
    openAddProjectToMachine({ projectRef: activeProjectRef, targetEnvironmentId });
  // A project on one machine still gets the picker when it can be added to another.
  const hasMultipleEnvironments = (availableEnvironments?.length ?? 0) > 1 || addTargets.length > 0;
  const showEnvironmentPicker = hasMultipleEnvironments && onEnvironmentChange !== undefined;
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  // Started threads get no handler but still show which machine they run on,
  // matching the strip visibility ChatView computes from the same inputs.
  const showEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });
  const [attachStrip, labelsOverflow] = useLabelsOverflow();

  if (!activeProject) return null;

  if (layout === "panel") {
    return (
      <div className="flex w-full flex-col" data-thread-panel-run-context>
        {panelSection !== "branch" && activeEnvironmentOption !== null ? (
          <RunContextSelector
            displayMode="panel"
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            envLocked={envLocked}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            showEnvironmentPicker={showEnvironmentPicker}
            onEnvironmentChange={onEnvironmentChange}
            addTargets={addTargets}
            onAddToMachine={onAddToMachine}
          />
        ) : null}
        {panelSection !== "workspace" ? (
          <BranchToolbarBranchSelector
            displayMode="panel"
            className="w-full"
            environmentId={environmentId}
            threadId={threadId}
            {...(draftId ? { draftId } : {})}
            {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
            {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
            {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
            {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
          />
        ) : null}
      </div>
    );
  }

  return (
    <ComposerSurface.ContextStrip
      ref={attachStrip}
      data-compact={labelsOverflow ? "" : undefined}
      className={cn("gap-1 text-xs font-normal text-foreground/70 dark:text-muted-foreground")}
    >
      {showGitControls && showEnvironmentIndicator ? (
        <div className="contents @xl/composer-surface:hidden">
          <RunContextSelector
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            envLocked={envLocked}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            showEnvironmentPicker={showEnvironmentPicker}
            onEnvironmentChange={onEnvironmentChange}
            addTargets={addTargets}
            onAddToMachine={onAddToMachine}
          />
        </div>
      ) : null}
      {showEnvironmentIndicator && availableEnvironments ? (
        <div
          className={cn(
            "min-h-7 min-w-10 items-center gap-1 sm:min-h-6",
            showGitControls ? "hidden @xl/composer-surface:flex" : "flex",
            "flex-1",
          )}
        >
          <BranchToolbarEnvironmentSelector
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            envLocked={envLocked}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            {...(showEnvironmentPicker ? { onEnvironmentChange } : {})}
            {...(addTargets.length > 0 ? { onAddToMachine: () => onAddToMachine(null) } : {})}
          />
          {showGitControls ? (
            <Separator
              orientation="vertical"
              className="mx-0.5 h-3.5!"
              data-composer-context-control
            />
          ) : null}
        </div>
      ) : null}

      {showGitControls ? (
        <BranchToolbarBranchSelector
          ref={branchSelectorRef}
          className="min-w-0 flex-initial justify-end @xl/composer-surface:ml-auto"
          environmentId={environmentId}
          threadId={threadId}
          {...(draftId ? { draftId } : {})}
          {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
          {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      ) : null}
      {trailing}
    </ComposerSurface.ContextStrip>
  );
});
