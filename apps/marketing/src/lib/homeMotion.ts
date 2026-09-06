/** Runs homepage motion only while its content is visible. Manual scrolling stops paging. */
export function startHomeMotion({
  hero,
  field,
  endorsements,
  caret,
}: {
  hero: HTMLElement;
  field: HTMLElement;
  endorsements: HTMLElement;
  caret: HTMLElement;
}) {
  if (typeof IntersectionObserver === "undefined") return () => {};

  const marks = Array.from(field.querySelectorAll<HTMLElement>(".hero-float-mark"));
  const visible = new Set<Element>();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine)");
  const events = new AbortController();
  const eventOptions = { signal: events.signal };
  let disposed = false;
  let hovered = endorsements.matches(":hover");
  let focused = endorsements.contains(document.activeElement);
  let userControlled = false;
  let direction = 1;
  let automaticScroll = false;
  let pageTimer: ReturnType<typeof setTimeout> | undefined;
  let pointerFrame: number | undefined;
  let pointer: { x: number; y: number } | null = null;

  const canMove = (element: Element) =>
    !disposed &&
    visible.has(element) &&
    document.visibilityState === "visible" &&
    !reducedMotion.matches;
  const canParallax = () => finePointer.matches && marks.some(canMove);
  const canPage = () =>
    canMove(endorsements) &&
    !hovered &&
    !focused &&
    !userControlled &&
    endorsements.scrollWidth > endorsements.clientWidth;

  function resetPointer() {
    if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
    pointerFrame = undefined;
    pointer = null;
    field.style.setProperty("--px", "0px");
    field.style.setProperty("--py", "0px");
  }

  function updatePaging() {
    if (canPage()) {
      pageTimer ??= setTimeout(advancePage, 8_000);
      return;
    }
    if (pageTimer !== undefined) clearTimeout(pageTimer);
    pageTimer = undefined;
    if (automaticScroll) {
      automaticScroll = false;
      endorsements.scrollTo({ left: endorsements.scrollLeft, behavior: "instant" });
    }
  }

  function advancePage() {
    pageTimer = undefined;
    if (!canPage()) return;
    const end = endorsements.scrollWidth - endorsements.clientWidth;
    const current = endorsements.scrollLeft;
    if (current >= end - 1) direction = -1;
    else if (current <= 1) direction = 1;
    automaticScroll = true;
    endorsements.scrollTo({
      left: Math.max(0, Math.min(end, current + direction * endorsements.clientWidth)),
      behavior: "smooth",
    });
    updatePaging();
  }

  function update() {
    for (const mark of marks) {
      mark.style.setProperty("--home-motion-state", canMove(mark) ? "running" : "paused");
    }
    caret.style.setProperty("--home-motion-state", canMove(caret) ? "running" : "paused");
    const parallax = canParallax();
    field.style.setProperty("--parallax-duration", parallax ? "0.7s" : "0s");
    if (!parallax) resetPointer();
    updatePaging();
  }

  const observer = new IntersectionObserver((entries) => {
    if (disposed) return;
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    update();
  });
  for (const element of [...marks, endorsements, caret]) observer.observe(element);

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
  endorsements.addEventListener(
    "pointerenter",
    () => {
      hovered = true;
      updatePaging();
    },
    eventOptions,
  );
  endorsements.addEventListener(
    "pointerleave",
    () => {
      hovered = false;
      updatePaging();
    },
    eventOptions,
  );
  endorsements.addEventListener(
    "focusin",
    () => {
      focused = true;
      updatePaging();
    },
    eventOptions,
  );
  endorsements.addEventListener(
    "focusout",
    (event) => {
      focused = event.relatedTarget instanceof Node && endorsements.contains(event.relatedTarget);
      updatePaging();
    },
    eventOptions,
  );
  const takeControl = () => {
    userControlled = true;
    updatePaging();
  };
  endorsements.addEventListener("wheel", takeControl, { ...eventOptions, passive: true });
  endorsements.addEventListener("pointerdown", takeControl, eventOptions);
  endorsements.addEventListener("keydown", takeControl, eventOptions);
  document.addEventListener("visibilitychange", update, eventOptions);
  window.addEventListener("resize", update, eventOptions);
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
