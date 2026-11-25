interface ObservedAnimation {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
}

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;

function setAnimationState(element: HTMLElement | SVGElement, running: boolean) {
  element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
  element.style.setProperty("--visible-animation-will-change", running ? "transform" : "auto");
}

function updateAnimation(animation: ObservedAnimation) {
  setAnimationState(
    animation.element,
    animation.intersecting && document.visibilityState === "visible" && !reducedMotion?.matches,
  );
}

function updateAnimations() {
  for (const animation of animations.values()) updateAnimation(animation);
}

export function observeVisibleAnimation(element: HTMLElement | SVGElement | null) {
  if (element === null) return;
  setAnimationState(element, false);
  if (typeof IntersectionObserver === "undefined") return;

  if (observer === null) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", updateAnimations);
    document.addEventListener("visibilitychange", updateAnimations);
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer) return;
      for (const entry of entries) {
        const animation = animations.get(entry.target);
        if (!animation) continue;
        animation.intersecting = entry.isIntersecting;
        updateAnimation(animation);
      }
    });
  }

  const animation = { element, intersecting: false };
  animations.set(element, animation);
  observer.observe(element);

  return () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    observer?.unobserve(element);
    setAnimationState(element, false);
    if (animations.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", updateAnimations);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", updateAnimations);
    }
  };
}
