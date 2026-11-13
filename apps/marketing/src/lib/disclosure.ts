/** Slides a <details> open and closed. Without JS, or with reduced motion, it toggles natively. */
export function animateDetails(details: HTMLDetailsElement) {
  const summary = details.querySelector("summary");
  const panel = details.querySelector<HTMLElement>("[data-panel]");
  if (!summary || !panel) return;

  let animation: Animation | undefined;
  let expanded = details.open;

  summary.addEventListener("click", (event) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    event.preventDefault();

    // Read the live height before cancelling, so an interrupted slide continues from where it is.
    const from = details.open ? panel.offsetHeight : 0;
    animation?.cancel();
    expanded = !expanded;
    details.open = true;
    details.toggleAttribute("data-closing", !expanded);
    const to = expanded ? panel.scrollHeight : 0;

    panel.style.overflow = "hidden";
    animation = panel.animate(
      { height: [`${from}px`, `${to}px`], opacity: [expanded ? 0 : 1, expanded ? 1 : 0] },
      { duration: 280, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
    );
    animation.onfinish = () => {
      panel.style.overflow = "";
      details.removeAttribute("data-closing");
      if (!expanded) details.open = false;
    };
  });
}
