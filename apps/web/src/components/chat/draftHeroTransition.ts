export const DRAFT_HERO_TRANSITION_ANIMATION_ID = "t3-draft-hero-transition";
export const DRAFT_HERO_TRANSITION_DURATION_MS = 180;
export const DRAFT_HERO_TRANSITION_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
export const MOBILE_COMPOSER_VIEW_TRANSITION_NAME = "t3-mobile-composer";
export const MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME = "t3-mobile-draft-headline";

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

export async function runMobileComposerTransition(
  update: () => void | Promise<void>,
): Promise<void> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    await update();
    return;
  }

  const transitionDocument = document as ComposerViewTransitionDocument;
  const mobileViewport = window.matchMedia?.("(max-width: 639px)").matches ?? false;
  const prefersReducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (!mobileViewport || prefersReducedMotion || !transitionDocument.startViewTransition) {
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
  transitionDocument.documentElement.dataset.mobileComposerRouteTransition = "true";
  try {
    const transition = transitionDocument.startViewTransition(runUpdate);
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
  }
}
