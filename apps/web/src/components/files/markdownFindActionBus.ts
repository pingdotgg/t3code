export const MARKDOWN_FIND_OPEN_EVENT = "t3:markdown-find-open";

export function getMarkdownFindTarget(target: EventTarget | null, maximized = false) {
  const element = target instanceof Element ? target : null;
  const direct = element?.closest<HTMLElement>("[data-markdown-preview]");
  if (direct) return direct.checkVisibility({ visibilityProperty: true }) ? direct : null;
  const scope = element?.closest("[data-file-preview-panel]") ?? (maximized ? document : null);
  return (
    [...(scope?.querySelectorAll<HTMLElement>("[data-markdown-preview]") ?? [])].find((node) =>
      node.checkVisibility({ visibilityProperty: true }),
    ) ?? null
  );
}

export function requestMarkdownFindOpen(target: EventTarget | null, maximized = false): boolean {
  const preview = getMarkdownFindTarget(target, maximized);
  return preview
    ? !preview.dispatchEvent(new Event(MARKDOWN_FIND_OPEN_EVENT, { cancelable: true }))
    : false;
}
