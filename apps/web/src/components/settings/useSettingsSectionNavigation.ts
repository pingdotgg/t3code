import { useState, type FocusEvent, type KeyboardEvent } from "react";

const SECTION = "[data-settings-section]";

/**
 * Settings sections share one Tab stop, and arrows move focus without opening a section.
 * The Tab stop follows the last focused section until the open section changes.
 */
export function useSettingsSectionNavigation(currentSection: string) {
  const [focused, setFocused] = useState<{ section: string; page: string } | null>(null);
  const tabStop = focused?.page === currentSection ? focused.section : currentSection;
  const remember = (element: HTMLElement) => {
    const section = element.dataset.settingsSection;
    if (section) setFocused({ section, page: currentSection });
  };
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.target instanceof HTMLElement && event.target.matches(SECTION))
      remember(event.target);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !(event.target instanceof HTMLElement) ||
      !event.target.matches(SECTION)
    )
      return;
    // Every section is a root leaf; Left and Right have no tree action.
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
    const target = next === undefined ? undefined : items[next];
    if (!target) return;
    event.preventDefault();
    remember(target);
    target.scrollIntoView({ block: "nearest" });
    target.focus({ preventScroll: true });
  };
  const tabIndexFor = (section: string) => (section === tabStop ? 0 : -1);
  return { containerProps: { onFocus, onKeyDown }, tabIndexFor };
}
