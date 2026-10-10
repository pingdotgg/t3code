/** Runs homepage motion (marquee, mark drift, caret, parallax) only while its content is visible. */
export function startHomeMotion({
  hero,
  field,
  tracks,
  caret,
}: {
  hero: HTMLElement;
  field: HTMLElement;
  tracks: HTMLElement[];
  caret: HTMLElement;
}) {
  if (typeof IntersectionObserver === "undefined") return () => {};

  const marks = Array.from(field.querySelectorAll<HTMLElement>(".hero-float-mark"));
  const gated = [...marks, ...tracks, caret];
  const visible = new Set<Element>();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine)");
  const events = new AbortController();
  const eventOptions = { signal: events.signal };
  let disposed = false;
  let pointerFrame: number | undefined;
  let pointer: { x: number; y: number } | null = null;

  const canMove = (element: Element) =>
    !disposed &&
    visible.has(element) &&
    document.visibilityState === "visible" &&
    !reducedMotion.matches;
  const canParallax = () => finePointer.matches && marks.some(canMove);

  function resetPointer() {
    if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
    pointerFrame = undefined;
    pointer = null;
    field.style.setProperty("--px", "0px");
    field.style.setProperty("--py", "0px");
  }

  function update() {
    for (const element of gated) {
      element.style.setProperty("--home-motion-state", canMove(element) ? "running" : "paused");
    }
    const parallax = canParallax();
    field.style.setProperty("--parallax-duration", parallax ? "0.7s" : "0s");
    if (!parallax) resetPointer();
  }

  const observer = new IntersectionObserver((entries) => {
    if (disposed) return;
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    update();
  });
  for (const element of gated) observer.observe(element);

  hero.addEventListener(
    "pointermove",
    (event) => {
      if (!canParallax()) return;
      pointer = { x: event.clientX, y: event.clientY };
      pointerFrame ??= requestAnimationFrame(() => {
        pointerFrame = undefined;
        if (!pointer || !canParallax()) return;
        const bounds = hero.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return;
        field.style.setProperty(
          "--px",
          `${(((pointer.x - bounds.left) / bounds.width - 0.5) * 36).toFixed(1)}px`,
        );
        field.style.setProperty(
          "--py",
          `${(((pointer.y - bounds.top) / bounds.height - 0.5) * 28).toFixed(1)}px`,
        );
      });
    },
    eventOptions,
  );
  hero.addEventListener("pointerleave", resetPointer, eventOptions);
  document.addEventListener("visibilitychange", update, eventOptions);
  reducedMotion.addEventListener("change", update, eventOptions);
  finePointer.addEventListener("change", update, eventOptions);
  update();

  return () => {
    if (disposed) return;
    disposed = true;
    events.abort();
    observer.disconnect();
    update();
  };
}
