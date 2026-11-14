import { flushSync } from "react-dom";

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
      } catch {}
    }),
  ]);
}

// Only a mobile view transition flushes `update` (its new snapshot must show it) and returns a
// promise; otherwise it runs inline so its state batches with the caller's. Errors never block.
export function runMobileComposerTransition(
  update: () => void,
  options: { active: boolean; durationMs: number },
): Promise<void> | undefined {
  if (typeof document === "undefined" || typeof window === "undefined") {
    runInlineUpdate(update);
    return;
  }

  const transitionDocument = document as ComposerViewTransitionDocument;
  const mobileViewport = window.matchMedia?.("(max-width: 639px)").matches ?? false;
  const prefersReducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const startViewTransition = transitionDocument.startViewTransition?.bind(transitionDocument);
  if (!options.active || !mobileViewport || prefersReducedMotion || !startViewTransition) {
    runInlineUpdate(update);
    return;
  }

  return new Promise<void>((resolveUpdated) => {
    let updateStarted = false;
    const runUpdate = () => {
      if (updateStarted) return;
      updateStarted = true;
      try {
        flushSync(update);
      } finally {
        resolveUpdated();
      }
    };
    void runViewTransition(startViewTransition, runUpdate, options.durationMs);
  });
}

function runInlineUpdate(update: () => void) {
  try {
    update();
  } catch {}
}

async function runViewTransition(
  startViewTransition: (update: () => void) => ComposerViewTransition,
  runUpdate: () => void,
  durationMs: number,
) {
  const root = document.documentElement;
  let transitionFinished: Promise<void> | null = null;
  root.style.setProperty(MOBILE_COMPOSER_TRANSITION_DURATION_PROPERTY, `${String(durationMs)}ms`);
  root.dataset.mobileComposerRouteTransition = "true";
  try {
    const transition = startViewTransition(runUpdate);
    transitionFinished = transition.finished.catch(() => undefined);
    activeMobileComposerTransition = transitionFinished;
    try {
      await transition.finished;
    } catch {
      runInlineUpdate(runUpdate);
    }
  } catch {
    runInlineUpdate(runUpdate);
  } finally {
    if (activeMobileComposerTransition === transitionFinished) {
      activeMobileComposerTransition = null;
    }
    delete root.dataset.mobileComposerRouteTransition;
    root.style.removeProperty(MOBILE_COMPOSER_TRANSITION_DURATION_PROPERTY);
  }
}
