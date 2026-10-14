import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";

const SECTION = "[data-settings-section]";

/** Settings sections use one Tab stop; moving focus does not navigate until activation. */
export function useSettingsSectionNavigation() {
  const ref = useRef<HTMLUListElement>(null);
  const tabStop = useRef<HTMLElement | null>(null);
  const currentPage = useRef<HTMLElement | null>(null);
  const setTabStop = (item: HTMLElement) => {
    if (tabStop.current === item) return;
    if (tabStop.current) tabStop.current.tabIndex = -1;
    item.tabIndex = 0;
    tabStop.current = item;
  };
  useLayoutEffect(() => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(SECTION) ?? []);
    const current = items.find((item) => item.getAttribute("aria-current") === "page") ?? null;
    const selected =
      items.find((item) => item === document.activeElement) ??
      (current !== currentPage.current ? current : tabStop.current) ??
      current ??
      items[0];
    const available = selected && items.includes(selected) ? selected : (current ?? items[0]);
    for (const item of items) item.tabIndex = item === available ? 0 : -1;
    tabStop.current = available ?? null;
    currentPage.current = current;
  });
  const onFocus = (event: FocusEvent<HTMLUListElement>) => {
    if (event.target instanceof HTMLElement && event.target.matches(SECTION))
      setTabStop(event.target);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !(event.target instanceof HTMLElement) ||
      !event.target.matches(SECTION)
    )
      return;
    // Every Settings section is a root leaf; Left and Right have no tree action.
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      return;
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(SECTION));
    const index = items.indexOf(event.target);
    const next =
      event.key === "ArrowDown"
        ? Math.min(index + 1, items.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : undefined;
    if (next === undefined || !items[next]) return;
    event.preventDefault();
    setTabStop(items[next]);
    items[next].scrollIntoView({ block: "nearest" });
    items[next].focus({ preventScroll: true });
  };
  return { ref, onFocus, onKeyDown };
}
