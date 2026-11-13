import { commands } from "vite-plus/test/browser";

function inView(scroller: Element, element: Element | undefined) {
  if (!element) return false;
  const view = scroller.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  return box.top >= view.top && box.bottom <= view.bottom;
}

/**
 * Drags a native selection with the real mouse from the start of `from`, scrolling 500px at a time
 * with the button held until `target()` is in view, and releases at the end of that row.
 */
export async function dragSelectWhileScrolling(
  scroller: Element,
  from: Element,
  target: () => Element | undefined,
) {
  const start = from.getBoundingClientRect();
  await commands.mouse("move", start.left + 1, start.top + start.height / 2);
  await commands.mouse("down");
  const view = scroller.getBoundingClientRect();
  const x = view.left + view.width / 2;
  const y = view.top + view.height / 2;
  let wiggle = 0;
  while (!inView(scroller, target())) {
    await commands.mouse("wheel", x, y, 500);
    // Chromium extends a drag selection on pointer moves, not on scrolling alone.
    wiggle ^= 1;
    await commands.mouse("move", x, y + wiggle);
  }
  const end = target()!.getBoundingClientRect();
  await commands.mouse("move", end.right - 1, end.top + end.height / 2);
  await commands.mouse("up");
}
