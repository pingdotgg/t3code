export const COMPOSER_CONTEXT_LAYOUT_EVENT = "t3:composer-context-layout";

function captureControl(element: HTMLElement, shellRect: DOMRect) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const icons = Array.from(element.querySelectorAll("svg, svg *"), (icon) => {
    const computed = getComputedStyle(icon);
    return {
      paint: {
        color: computed.color,
        fill: computed.fill,
        stroke: computed.stroke,
        opacity: computed.opacity,
      },
      layout: {
        width: computed.width,
        height: computed.height,
        margin: computed.margin,
        flexShrink: computed.flexShrink,
      },
    };
  });
  return {
    element,
    font: style.font,
    unclippedLabels: Array.from(
      element.querySelectorAll<HTMLElement>(".truncate"),
      (label) => label.scrollWidth <= label.clientWidth + 1,
    ),
    position: {
      left: rect.left - shellRect.left,
      top: rect.top - shellRect.bottom,
      width: rect.width,
      height: rect.height,
    },
    appearance: {
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      fontWeight: style.fontWeight,
    },
    icons,
  };
}

/** Positions relative to the shell's stable bottom edge, shared across the two control hosts. */
export function captureComposerControls(
  group: HTMLElement | null,
  shell: HTMLElement,
  prefix = "",
) {
  const shellRect = shell.getBoundingClientRect();
  const controls = new Map<string, ReturnType<typeof captureControl>>();
  let precedingControl = "start";
  let controlIndex = 0;
  const elements = group
    ? [
        ...(group.matches('button, [role="separator"]') ? [group] : []),
        ...group.querySelectorAll<HTMLElement>('button, [role="separator"]'),
      ]
    : [];
  for (const element of elements) {
    const separator = element.matches('[role="separator"]');
    const key = separator
      ? `separator:${precedingControl}`
      : element.getAttribute("aria-label") || `control:${controlIndex++}`;
    if (!separator) precedingControl = key;
    if (element.closest('[inert], [aria-hidden="true"]')) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || getComputedStyle(element).visibility === "hidden") continue;
    controls.set(`${prefix}${key}`, captureControl(element, shellRect));
  }
  return controls;
}

export type ComposerControlPositions = ReturnType<typeof captureComposerControls>;

/** Carry visual copies across the clipped editor while the real controls remain in their final hosts. */
export function animateComposerControls(
  shell: HTMLElement,
  previous: ComposerControlPositions,
  next: ComposerControlPositions,
  options: KeyframeAnimationOptions,
) {
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  layer.dataset.composerControlsTransition = "true";
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    zIndex: "30",
  });
  const moving = new Map<string, { element: HTMLElement; animations: Animation[] }>();
  const restore: (() => void)[] = [];

  for (const [key, target] of next) {
    const source = previous.get(key);
    if (!source) continue;
    const clone = target.element.cloneNode(true);
    if (!(clone instanceof HTMLElement)) continue;
    clone.removeAttribute("id");
    for (const descendant of clone.querySelectorAll("[id]")) descendant.removeAttribute("id");
    for (const [index, label] of Array.from(
      clone.querySelectorAll<HTMLElement>(".truncate"),
    ).entries()) {
      // Interpolating the weight can briefly add a pixel to otherwise fitting
      // text. Do not turn that into an ellipsis in the moving copy.
      if (target.unclippedLabels[index]) {
        label.style.overflow = "visible";
        label.style.textOverflow = "clip";
      }
    }
    Object.assign(clone.style, {
      position: "absolute",
      left: `${target.position.left}px`,
      bottom: `${-target.position.top - target.position.height}px`,
      width: `${target.position.width}px`,
      height: `${target.position.height}px`,
      minWidth: "0",
      maxWidth: "none",
      margin: "0",
      font: target.font,
      color: target.appearance.color,
      transformOrigin: "top left",
      transition: "none",
      pointerEvents: "none",
    });
    layer.append(clone);
    const visibility = target.element.style.visibility;
    const transitionProperty = target.element.style.transitionProperty;
    // `transition-all` also transitions visibility: the real button would
    // remain visible beside its moving copy, then disappear at cleanup.
    target.element.style.transitionProperty = "none";
    target.element.style.visibility = "hidden";
    restore.push(() => {
      target.element.style.visibility = visibility;
      // Commit the visibility handoff before restoring the button's own CSS
      // transitions, so the next geometry capture sees the real control.
      void getComputedStyle(target.element).visibility;
      target.element.style.transitionProperty = transitionProperty;
    });
    const animation = clone.animate(
      [
        {
          ...source.appearance,
          transform: `translate(${source.position.left - target.position.left}px, ${source.position.top - target.position.top}px) scale(${source.position.width / target.position.width}, ${source.position.height / target.position.height})`,
        },
        { ...target.appearance, transform: "none" },
      ],
      { ...options, fill: "both" },
    );
    const animations = [animation];
    for (const [index, icon] of Array.from(
      clone.querySelectorAll<SVGElement>("svg, svg *"),
    ).entries()) {
      const from = source.icons[index]?.paint;
      const targetIcon = target.icons[index];
      if (!targetIcon || !from) continue;
      const to = targetIcon.paint;
      // Freeze the icon's layout and remove utility overrides so its actual
      // fill/stroke colors can interpolate, including !important variants.
      icon.removeAttribute("class");
      Object.assign(icon.style, {
        ...targetIcon.layout,
        ...to,
      });
      animations.push(icon.animate([from, to], { ...options, fill: "both" }));
    }
    moving.set(key, { element: clone, animations });
  }
  shell.append(layer);

  return {
    capture() {
      const shellRect = shell.getBoundingClientRect();
      return new Map(
        Array.from(moving, ([key, { element }]) => [key, captureControl(element, shellRect)]),
      );
    },
    finish() {
      for (const { animations } of moving.values()) {
        for (const animation of animations) animation.cancel();
      }
      for (const reset of restore) reset();
      layer.remove();
    },
  };
}
