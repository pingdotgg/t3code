import {
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import {
  resolveComposerTimelineInset,
  shouldAnimateComposerRestingTransition,
} from "../composerFooterLayout";
import { ComposerSurface } from "./ComposerSurface";

export type ComposerFrameMode = "expanded" | "resting" | "mobile-collapsed";

export interface ComposerFrameLayout {
  mode: ComposerFrameMode;
  /** Destination height, held steady while the composer animates. */
  visibleHeight: number;
  /** Space for the expanded composer, including while it rests. */
  reservedHeight: number;
}

export interface ComposerFrameProps {
  children: ReactNode;
  mode: ComposerFrameMode;
  layoutKey: string | null;
  isDraftHeroState: boolean;
  headline: ReactNode;
  contextStrip: ReactNode;
  showContextStrip: boolean;
  transitionGroupRef: Ref<HTMLDivElement>;
  composerAnchorRef: Ref<HTMLDivElement>;
  viewTransitionName: string | undefined;
  restingControlsRef: RefObject<HTMLDivElement | null>;
  onLayoutChange: (layout: ComposerFrameLayout) => void;
}

const COMPOSER_RESTING_TRANSITION_DURATION_MS = 280;
const COMPOSER_RESTING_TRANSITION_CLEANUP_BUFFER_MS = 50;
const COMPOSER_RESTING_TRANSITION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_RESTING_CONTROLS_ARRIVAL_DRIFT_PX = 4;

function useComposerFrameLayout({
  mode,
  layoutKey,
  isDraftHeroState,
  showContextStrip,
  restingControlsRef,
  onLayoutChange,
}: Pick<
  ComposerFrameProps,
  | "mode"
  | "layoutKey"
  | "isDraftHeroState"
  | "showContextStrip"
  | "restingControlsRef"
  | "onLayoutChange"
>) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const isCollapsed = mode !== "expanded";
  const previousLayoutKeyRef = useRef(layoutKey);
  const lastLayoutRef = useRef<{
    key: string | null;
    layout: ComposerFrameLayout;
  } | null>(null);
  const publishLayout = useCallback(
    (height: number) => {
      const visibleHeight = Math.ceil(height);
      if (visibleHeight <= 0 || !Number.isFinite(visibleHeight)) return;
      const previous = lastLayoutRef.current;
      const reservedHeight = resolveComposerTimelineInset({
        currentInset: previous?.key === layoutKey ? previous.layout.reservedHeight : 0,
        overlayHeight: visibleHeight,
        isResting: mode === "resting",
      });
      if (
        previous?.key === layoutKey &&
        previous.layout.mode === mode &&
        previous.layout.visibleHeight === visibleHeight &&
        previous.layout.reservedHeight === reservedHeight
      ) {
        return;
      }
      const layout = { mode, visibleHeight, reservedHeight };
      lastLayoutRef.current = { key: layoutKey, layout };
      onLayoutChange(layout);
    },
    [layoutKey, mode, onLayoutChange],
  );
  const previousCollapsedRef = useRef(isCollapsed);
  const previousHeightRef = useRef<number | null>(null);
  const previousContentOffsetsRef = useRef<{
    promptFromTop: number | null;
    promptHeight: number | null;
    actionFromBottom: number | null;
  }>({ promptFromTop: null, promptHeight: null, actionFromBottom: null });
  const animationRef = useRef<Animation | null>(null);
  const animationTargetHeightRef = useRef<number | null>(null);
  const contentAnimationsRef = useRef<Animation[]>([]);
  const stateChangeAnimationsRef = useRef<Animation[]>([]);
  const pinnedOverlayRef = useRef<HTMLElement | null>(null);
  const transitionCleanupTimeoutRef = useRef<number | null>(null);
  const transitionLayoutRequestRef = useRef(0);
  const hasCompletedInitialLayoutRef = useRef(false);

  const clearOverlayPin = useCallback(() => {
    // Keep the pinned element available through ref detachment on unmount.
    const overlay = pinnedOverlayRef.current;
    pinnedOverlayRef.current = null;
    overlay?.style.removeProperty("height");
    overlay?.style.removeProperty("display");
    overlay?.style.removeProperty("flex-direction");
    overlay?.style.removeProperty("justify-content");
  }, []);

  const clearTransitionStyles = useCallback(() => {
    const element = overlayRef.current?.querySelector<HTMLElement>(
      '[data-chat-composer-main-surface="true"]',
    );
    const footer = element?.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
    element?.style.removeProperty("overflow");
    element
      ?.querySelector<HTMLElement>('[data-chat-composer-surface="true"]')
      ?.style.removeProperty("height");
    footer?.style.removeProperty("position");
    footer?.style.removeProperty("top");
    footer?.style.removeProperty("bottom");
    footer?.style.removeProperty("left");
    footer?.style.removeProperty("right");
    footer?.style.removeProperty("height");
    clearOverlayPin();
  }, [clearOverlayPin]);

  const transitionToCurrentGeometry = useCallback(
    (stateChanged: boolean) => {
      const element = overlayRef.current?.querySelector<HTMLElement>(
        '[data-chat-composer-main-surface="true"]',
      );
      const surface = element?.querySelector<HTMLElement>('[data-chat-composer-surface="true"]');
      if (!element || !surface) return;

      const nextIsCollapsed = isCollapsed;

      const visibleTransitionElement = (selector: string) =>
        Array.from(element.querySelectorAll<HTMLElement>(selector)).find(
          (candidate) => candidate.getClientRects().length > 0,
        ) ?? null;
      const prompt = visibleTransitionElement(
        '[data-testid="composer-editor"], [data-chat-composer-transition-prompt="true"]',
      );
      const action = visibleTransitionElement('[data-chat-composer-transition-actions="true"]');
      const footer = element.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
      const interruptedAnimation = animationRef.current;
      const interruptedPromptTop = interruptedAnimation
        ? (prompt?.getBoundingClientRect().top ?? null)
        : null;
      const interruptedActionTop = interruptedAnimation
        ? (action?.getBoundingClientRect().top ?? null)
        : null;
      const interruptedHeight = interruptedAnimation
        ? element.getBoundingClientRect().height
        : null;
      const interruptedTargetHeight = animationTargetHeightRef.current;
      const interruptedCurrentTime =
        typeof interruptedAnimation?.currentTime === "number"
          ? interruptedAnimation.currentTime
          : null;
      const interruptedDuration = interruptedAnimation?.effect?.getComputedTiming().duration;
      if (transitionCleanupTimeoutRef.current !== null) {
        window.clearTimeout(transitionCleanupTimeoutRef.current);
        transitionCleanupTimeoutRef.current = null;
      }
      interruptedAnimation?.cancel();
      animationRef.current = null;
      for (const animation of contentAnimationsRef.current) animation.cancel();
      contentAnimationsRef.current = [];
      // The reveal and fade animations keep their own schedule across the
      // body-resize re-entries that retarget the geometry mid-flight (every
      // transition with a draft triggers one); cancelling them there would
      // pop their subjects to full visibility at the start of the tween.
      if (stateChanged) {
        for (const animation of stateChangeAnimationsRef.current) animation.cancel();
        stateChangeAnimationsRef.current = [];
      }
      clearTransitionStyles();

      const nextRect = element.getBoundingClientRect();
      const nextHeight = nextRect.height;
      // Publish the destination once. The frame stays at this height during
      // the animation, so consumers do not update on every animation frame.
      const overlay = overlayRef.current;
      const overlayHeight = overlay?.getBoundingClientRect().height ?? null;
      if (overlayHeight !== null) {
        publishLayout(overlayHeight);
      }
      const nextPromptRect = prompt?.getBoundingClientRect() ?? null;
      const nextPromptTop = nextPromptRect?.top ?? null;
      const nextActionTop = action?.getBoundingClientRect().top ?? null;
      const previousHeight = interruptedHeight ?? previousHeightRef.current;
      const targetChanged =
        interruptedTargetHeight === null || Math.abs(interruptedTargetHeight - nextHeight) >= 0.5;
      const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const shouldAnimate = shouldAnimateComposerRestingTransition({
        hasCompletedInitialLayout: hasCompletedInitialLayoutRef.current,
        stateChanged,
        hasInterruptedAnimation: interruptedHeight !== null,
      });

      if (
        shouldAnimate &&
        !prefersReducedMotion &&
        previousHeight !== null &&
        Math.abs(previousHeight - nextHeight) >= 0.5
      ) {
        const remainingDuration =
          typeof interruptedDuration === "number" && interruptedCurrentTime !== null
            ? Math.max(1, interruptedDuration - interruptedCurrentTime)
            : COMPOSER_RESTING_TRANSITION_DURATION_MS;
        const duration =
          interruptedHeight !== null && !targetChanged
            ? remainingDuration
            : COMPOSER_RESTING_TRANSITION_DURATION_MS;
        element.style.overflow = "clip";
        surface.style.height = "100%";

        // Pinning the overlay at the destination height keeps the resize
        // observer quiet for the tween; bottom alignment keeps the animating
        // surface glued to the overlay's stable bottom edge. The pin lasts
        // only for the tween so later attachment, thread, font, and viewport
        // changes remain natural.
        if (overlay && overlayHeight !== null) {
          overlay.style.height = `${String(overlayHeight)}px`;
          overlay.style.display = "flex";
          overlay.style.flexDirection = "column";
          overlay.style.justifyContent = "flex-end";
          pinnedOverlayRef.current = overlay;
        }

        // Keep the footer attached to the stable bottom edge while the outer
        // height changes. Its resting absolute layout otherwise spans the old
        // height on collapse, while its expanded flow layout falls below the
        // clipped surface on expansion.
        if (footer) {
          footer.style.position = "absolute";
          footer.style.top = "auto";
          footer.style.bottom = "1px";
          footer.style.height = "3rem";
          if (nextIsCollapsed) {
            footer.style.left = "auto";
            footer.style.right = "1px";
          } else {
            footer.style.left = "1px";
            footer.style.right = "1px";
          }
        }

        const animation = element.animate(
          [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
          {
            duration,
            easing: COMPOSER_RESTING_TRANSITION_EASING,
          },
        );
        animationRef.current = animation;
        animationTargetHeightRef.current = nextHeight;

        const animatedRect = element.getBoundingClientRect();
        const previousPromptTop =
          interruptedPromptTop ??
          (previousContentOffsetsRef.current.promptFromTop === null
            ? null
            : animatedRect.top + previousContentOffsetsRef.current.promptFromTop);
        const previousActionTop =
          interruptedActionTop ??
          (previousContentOffsetsRef.current.actionFromBottom === null
            ? null
            : animatedRect.bottom - previousContentOffsetsRef.current.actionFromBottom);
        const contentAnimations: Animation[] = [];
        const animateContentPosition = (
          content: HTMLElement | null,
          previousTop: number | null,
        ) => {
          if (!content || previousTop === null) return;
          const offset = previousTop - content.getBoundingClientRect().top;
          if (Math.abs(offset) < 0.5) return;
          contentAnimations.push(
            content.animate(
              [{ transform: `translateY(${String(offset)}px)` }, { transform: "none" }],
              {
                duration,
                easing: COMPOSER_RESTING_TRANSITION_EASING,
              },
            ),
          );
        };
        animateContentPosition(prompt, previousPromptTop);
        animateContentPosition(action, previousActionTop);
        contentAnimationsRef.current = contentAnimations;

        if (stateChanged) {
          const stateChangeAnimations: Animation[] = [];

          // A prompt that gains lines on expansion would otherwise slide up
          // from under the footer band as one block. Opening a bottom clip in
          // step with the tween instead unfurls the extra lines beneath the
          // rising first line, so no text crosses the returning controls.
          const previousPromptHeight = previousContentOffsetsRef.current.promptHeight;
          if (
            !nextIsCollapsed &&
            prompt &&
            nextPromptRect &&
            previousPromptHeight !== null &&
            nextPromptRect.height - previousPromptHeight >= 0.5
          ) {
            const hiddenHeight = nextPromptRect.height - previousPromptHeight;
            stateChangeAnimations.push(
              prompt.animate(
                [
                  { clipPath: `inset(0 0 ${String(hiddenHeight)}px 0)` },
                  { clipPath: "inset(0 0 0 0)" },
                ],
                {
                  duration,
                  easing: COMPOSER_RESTING_TRANSITION_EASING,
                },
              ),
            );
          }

          // The footer controls teleport between the composer footer and the
          // context strip below it in a single commit. Fading the arriving
          // cluster in along its direction of travel reads as one continuous
          // move instead of a pop. Collapsing controls land in empty strip
          // space and can appear immediately, but expanding controls return
          // to the bottom row the prompt still occupies while the surface is
          // short, so they stay hidden through the first half of the tween
          // and fade in once the geometry has mostly settled.
          const arrivingControls = nextIsCollapsed
            ? restingControlsRef.current
            : element.querySelector<HTMLElement>('[data-chat-composer-controls="left"]');
          if (arrivingControls) {
            const drift = nextIsCollapsed
              ? -COMPOSER_RESTING_CONTROLS_ARRIVAL_DRIFT_PX
              : COMPOSER_RESTING_CONTROLS_ARRIVAL_DRIFT_PX;
            stateChangeAnimations.push(
              arrivingControls.animate(
                [
                  { opacity: 0, transform: `translateY(${String(drift)}px)` },
                  { opacity: 1, transform: "none" },
                ],
                {
                  duration: nextIsCollapsed ? duration : duration / 2,
                  delay: nextIsCollapsed ? 0 : duration / 2,
                  fill: "backwards",
                  easing: COMPOSER_RESTING_TRANSITION_EASING,
                },
              ),
            );
          }

          const arrivingImagePreviews = nextIsCollapsed
            ? Array.from(
                element.querySelectorAll<HTMLElement>('[data-chat-composer-resting-images="true"]'),
              )
            : Array.from(
                element.querySelectorAll<HTMLElement>('[data-chat-composer-expanded-image="true"]'),
              );
          for (const imagePreview of arrivingImagePreviews) {
            stateChangeAnimations.push(
              imagePreview.animate([{ opacity: 0 }, { opacity: 1 }], {
                duration: nextIsCollapsed ? duration : duration / 2,
                delay: nextIsCollapsed ? 0 : duration / 2,
                fill: "backwards",
                easing: COMPOSER_RESTING_TRANSITION_EASING,
              }),
            );
          }
          stateChangeAnimationsRef.current = stateChangeAnimations;
        }

        const finishTransition = (cancelAnimations: boolean) => {
          if (animationRef.current !== animation) return;
          if (transitionCleanupTimeoutRef.current !== null) {
            window.clearTimeout(transitionCleanupTimeoutRef.current);
            transitionCleanupTimeoutRef.current = null;
          }
          if (cancelAnimations) {
            animation.cancel();
            for (const contentAnimation of contentAnimationsRef.current) {
              contentAnimation.cancel();
            }
            for (const stateChangeAnimation of stateChangeAnimationsRef.current) {
              stateChangeAnimation.cancel();
            }
          }
          animationRef.current = null;
          animationTargetHeightRef.current = null;
          contentAnimationsRef.current = [];
          stateChangeAnimationsRef.current = [];
          clearTransitionStyles();
        };
        void animation.finished.catch(() => undefined).then(() => finishTransition(false));
        // A suspended document timeline can leave `finished` pending while
        // these measurement styles remain active. Wall-clock cleanup makes
        // the natural layout the eventual source of truth in that case.
        transitionCleanupTimeoutRef.current = window.setTimeout(
          () => finishTransition(true),
          duration + COMPOSER_RESTING_TRANSITION_CLEANUP_BUFFER_MS,
        );
      } else {
        animationTargetHeightRef.current = null;
      }

      previousCollapsedRef.current = nextIsCollapsed;
      previousHeightRef.current = nextHeight;
      previousContentOffsetsRef.current = {
        promptFromTop: nextPromptTop === null ? null : nextPromptTop - nextRect.top,
        promptHeight: nextPromptRect?.height ?? null,
        actionFromBottom: nextActionTop === null ? null : nextRect.bottom - nextActionTop,
      };
    },
    [clearTransitionStyles, isCollapsed, publishLayout, restingControlsRef],
  );

  const stopTransition = useCallback(() => {
    if (transitionCleanupTimeoutRef.current !== null) {
      window.clearTimeout(transitionCleanupTimeoutRef.current);
      transitionCleanupTimeoutRef.current = null;
    }
    animationRef.current?.cancel();
    animationRef.current = null;
    animationTargetHeightRef.current = null;
    for (const animation of contentAnimationsRef.current) animation.cancel();
    contentAnimationsRef.current = [];
    for (const animation of stateChangeAnimationsRef.current) animation.cancel();
    stateChangeAnimationsRef.current = [];
    clearTransitionStyles();
  }, [clearTransitionStyles]);

  useLayoutEffect(() => {
    if (previousLayoutKeyRef.current !== layoutKey) {
      previousLayoutKeyRef.current = layoutKey;
      stopTransition();
      previousHeightRef.current = null;
      previousCollapsedRef.current = isCollapsed;
    }
    // The first inset lets the timeline decide whether it overflows before
    // initial geometry settles. Otherwise that feedback looks like a later
    // user collapse and animates a newly opened thread.
    if (lastLayoutRef.current?.key !== layoutKey && overlayRef.current) {
      publishLayout(overlayRef.current.getBoundingClientRect().height);
    }
    const requestId = transitionLayoutRequestRef.current + 1;
    transitionLayoutRequestRef.current = requestId;
    const stateChanged = previousCollapsedRef.current !== isCollapsed;
    // Resting controls can bring the context strip into flow in this commit.
    // Read the final geometry after those layout updates and before paint.
    queueMicrotask(() => {
      if (transitionLayoutRequestRef.current !== requestId) return;
      transitionToCurrentGeometry(stateChanged);
    });
    return () => {
      if (transitionLayoutRequestRef.current === requestId) {
        transitionLayoutRequestRef.current += 1;
      }
    };
  }, [
    isCollapsed,
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- Hero and context strip changes alter the measured CSS geometry.
    isDraftHeroState,
    layoutKey,
    publishLayout,
    showContextStrip,
    stopTransition,
    transitionToCurrentGeometry,
  ]);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const element = overlay?.querySelector<HTMLElement>('[data-chat-composer-main-surface="true"]');
    if (!overlay || !element || typeof ResizeObserver === "undefined") return;

    const body = element.querySelector<HTMLElement>('[data-chat-composer-body="true"]');
    const observer = new ResizeObserver((entries) => {
      if (animationRef.current) {
        if (body && entries.some((entry) => entry.target === body)) {
          transitionToCurrentGeometry(false);
        }
        return;
      }
      const elementRect = element.getBoundingClientRect();
      const visibleTransitionElement = (selector: string) =>
        Array.from(element.querySelectorAll<HTMLElement>(selector)).find(
          (candidate) => candidate.getClientRects().length > 0,
        ) ?? null;
      const promptRect = visibleTransitionElement(
        '[data-testid="composer-editor"], [data-chat-composer-transition-prompt="true"]',
      )?.getBoundingClientRect();
      const actionTop = visibleTransitionElement(
        '[data-chat-composer-transition-actions="true"]',
      )?.getBoundingClientRect().top;
      publishLayout(overlay.getBoundingClientRect().height);
      previousHeightRef.current = elementRect.height;
      previousContentOffsetsRef.current = {
        promptFromTop: promptRect === undefined ? null : promptRect.top - elementRect.top,
        promptHeight: promptRect?.height ?? null,
        actionFromBottom: actionTop === undefined ? null : elementRect.bottom - actionTop,
      };
    });
    observer.observe(overlay);
    observer.observe(element);
    if (body) observer.observe(body);
    return () => observer.disconnect();
  }, [publishLayout, transitionToCurrentGeometry]);

  useEffect(() => {
    // Host discovery and width measurement settle through layout updates on
    // mount. Treat that bootstrap as initial geometry so an existing thread
    // paints at rest instead of visibly collapsing from the expanded height.
    hasCompletedInitialLayoutRef.current = true;
    return stopTransition;
  }, [stopTransition]);

  return overlayRef;
}

/** Owns the overlay, its resting transition, and the timeline reservation. */
export function ComposerFrame({
  children,
  mode,
  layoutKey,
  isDraftHeroState,
  headline,
  contextStrip,
  showContextStrip,
  transitionGroupRef,
  composerAnchorRef,
  viewTransitionName,
  restingControlsRef,
  onLayoutChange,
}: ComposerFrameProps) {
  const overlayRef = useComposerFrameLayout({
    mode,
    layoutKey,
    isDraftHeroState,
    showContextStrip,
    restingControlsRef,
    onLayoutChange,
  });
  return (
    <div
      ref={overlayRef}
      data-chat-composer-overlay="true"
      className={
        isDraftHeroState
          ? "pointer-events-none absolute inset-0 z-20 flex items-center"
          : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
      }
    >
      <div
        ref={transitionGroupRef}
        className="w-full ps-[calc(env(safe-area-inset-left)+0.75rem)] pe-[calc(env(safe-area-inset-right)+0.75rem)] sm:ps-[calc(env(safe-area-inset-left)+1.25rem)] sm:pe-[calc(env(safe-area-inset-right)+1.25rem)]"
      >
        <div className="group/composer-stack pointer-events-auto relative z-10">
          {headline}
          <div className="relative" style={viewTransitionName ? { viewTransitionName } : undefined}>
            <ComposerSurface.Shell contextStrip={showContextStrip}>
              <ComposerSurface.Host>
                <div ref={composerAnchorRef} className="relative z-10">
                  {children}
                </div>
              </ComposerSurface.Host>
              {contextStrip}
            </ComposerSurface.Shell>
            <div
              aria-hidden
              className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
