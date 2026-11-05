export function contextStripGroupWidth(group: HTMLElement): number {
  if ((Number.parseFloat(getComputedStyle(group).flexGrow) || 0) === 0) return group.offsetWidth;
  const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0;
  let width = 0;
  let counted = 0;
  for (const child of group.children) {
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
}
