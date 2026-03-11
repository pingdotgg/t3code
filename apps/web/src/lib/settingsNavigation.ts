export interface SettingsEscapeEventLike {
  key: string;
  defaultPrevented?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function shouldCloseSettingsOnEscape(event: SettingsEscapeEventLike): boolean {
  return (
    event.key === "Escape" &&
    event.defaultPrevented !== true &&
    event.metaKey !== true &&
    event.ctrlKey !== true &&
    event.altKey !== true &&
    event.shiftKey !== true
  );
}

export function canNavigateBackInApp(historyState: unknown): boolean {
  if (!historyState || typeof historyState !== "object") {
    return false;
  }

  const index = (historyState as { __TSR_index?: unknown }).__TSR_index;
  return typeof index === "number" && index > 0;
}
