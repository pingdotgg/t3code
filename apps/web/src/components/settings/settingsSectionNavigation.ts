import type { KeyboardEvent } from "react";

const SECTION = "[data-settings-section]";

/** Arrow keys move focus between settings sections without opening them. */
export function handleSettingsSectionKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !(event.target instanceof HTMLElement) ||
    !event.target.matches(SECTION)
  )
    return;
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
  const target = next === undefined ? undefined : items[next];
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ block: "nearest" });
  target.focus({ preventScroll: true });
}
