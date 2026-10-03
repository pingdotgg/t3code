/**
 * The inline room a box leaves its children.
 *
 * `clientWidth` is the padding box, so it is not room children can occupy: two
 * fit decisions that must agree at one container drift apart by its inline
 * padding the moment one of them reads `clientWidth` directly. Logical props
 * keep that true whichever way the text runs.
 *
 * `style` lets a caller that already resolved the box's computed style reuse it:
 * these reads land in measurement paths that run on every render.
 */
export function contentInlineWidth(
  element: HTMLElement,
  style: CSSStyleDeclaration = getComputedStyle(element),
): number {
  const padding =
    (Number.parseFloat(style.paddingInlineStart) || 0) +
    (Number.parseFloat(style.paddingInlineEnd) || 0);
  return element.clientWidth - padding;
}
