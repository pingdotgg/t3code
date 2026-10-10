export const DRAFT_HERO_TRANSITION_ANIMATION_ID = "t3-draft-hero-transition";
export const DRAFT_HERO_TRANSITION_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
export const MOBILE_COMPOSER_VIEW_TRANSITION_NAME = "t3-mobile-composer";
export const MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME = "t3-mobile-draft-headline";
const MOBILE_COMPOSER_TRANSITION_DURATION_PROPERTY = "--mobile-composer-transition-duration";

type ComposerViewTransition = {
  readonly finished: Promise<void>;
};

let activeMobileComposerTransition: Promise<void> | null = null;

type ComposerViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => ComposerViewTransition;
};

export async function waitForDraftHeroTransition(): Promise<void> {
  const mobileComposerTransition = activeMobileComposerTransition;
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") {
    await mobileComposerTransition;
    return;
  }

  const activeTransitions = document
    .getAnimations()
    .filter((animation) => animation.id === DRAFT_HERO_TRANSITION_ANIMATION_ID);

  await Promise.all([
    mobileComposerTransition,
    ...activeTransitions.map(async (animation) => {
      try {
        await animation.finished;
      } catch {
        // A cancelled transition is already safe to hand off.
      }
    }),
  ]);
}

/**
 * Whether `runMobileComposerTransition` runs its update inside a view
 * transition. Otherwise it runs the update synchronously.
 */
export function isMobileComposerTransitionEnabled(active: boolean): boolean {
  if (!active || typeof document === "undefined" || typeof window === "undefined") return false;
  const mobileViewport = window.matchMedia?.("(max-width: 639px)").matches ?? false;
  const prefersReducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  return (
    mobileViewport &&
    !prefersReducedMotion &&
    Boolean((document as ComposerViewTransitionDocument).startViewTransition)
  );
}

export async function runMobileComposerTransition(
  update: () => void | Promise<void>,
  options: { active: boolean; durationMs: number },
): Promise<void> {
  if (!isMobileComposerTransitionEnabled(options.active)) {
    await update();
    return;
  }

  const transitionDocument = document as ComposerViewTransitionDocument;
  const startViewTransition = transitionDocument.startViewTransition;
  if (!startViewTransition) {
    await update();
    return;
  }

  let updateStarted = false;
  const runUpdate = async () => {
    if (updateStarted) return;
    updateStarted = true;
    await update();
  };
  let transitionFinished: Promise<void> | null = null;
  transitionDocument.documentElement.style.setProperty(
    MOBILE_COMPOSER_TRANSITION_DURATION_PROPERTY,
    `${String(options.durationMs)}ms`,
  );
  transitionDocument.documentElement.dataset.mobileComposerRouteTransition = "true";
  try {
    const transition = startViewTransition.call(transitionDocument, runUpdate);
    transitionFinished = transition.finished.catch(() => undefined);
    activeMobileComposerTransition = transitionFinished;
    try {
      await transition.finished;
    } catch {
      await runUpdate();
    }
  } catch {
    await runUpdate();
  } finally {
    if (activeMobileComposerTransition === transitionFinished) {
      activeMobileComposerTransition = null;
    }
    delete transitionDocument.documentElement.dataset.mobileComposerRouteTransition;
    transitionDocument.documentElement.style.removeProperty(
      MOBILE_COMPOSER_TRANSITION_DURATION_PROPERTY,
    );
  }
}
