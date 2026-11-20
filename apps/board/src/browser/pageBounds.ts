import { browserHost } from "./host";

let area: HTMLElement | null = null;
let paused = false;

function report() {
  if (browserHost === null) return;
  const rect = area?.getBoundingClientRect();
  browserHost.setBounds(
    rect === undefined || paused || rect.width <= 0 || rect.height <= 0
      ? null
      : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  );
}

/** A ref callback: the active tab's native page fills this element, so its rectangle is reported while it is mounted. */
export function trackPageArea(element: HTMLElement | null) {
  if (element === null) return;
  area = element;
  report();
  const observer = new ResizeObserver(report);
  observer.observe(element);
  window.addEventListener("resize", report);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", report);
    area = null;
    report();
  };
}

/** Hides the page while the panel is being dragged, because a native page takes the pointer from the drag. */
export function pausePage(next: boolean) {
  paused = next;
  report();
}
