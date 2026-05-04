export const originalSetTimeout = window.setTimeout.bind(window);
export const originalSetInterval = window.setInterval.bind(window);
export const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);

export function freeze() {
  return;
}

export function unfreeze() {
  return;
}
