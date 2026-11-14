export function getDiffHeaderClickAction(event: MouseEvent) {
  const path = event.composedPath();
  // Controls own their actions; handling the chevron here too would toggle twice.
  for (const node of path) {
    if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) return null;
  }
  const title = path.find(
    (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-title"),
  );
  if (title?.textContent) return { type: "open" as const, filePath: title.textContent };

  const header = path.find(
    (node): node is HTMLElement =>
      node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
  );
  const root = header?.getRootNode();
  // Pierre renders the prefix through a slot; its React controls live on the shadow host.
  const fileKey =
    root instanceof ShadowRoot
      ? root.host.querySelector("[data-diff-file-key]")?.getAttribute("data-diff-file-key")
      : null;
  return fileKey ? { type: "toggle" as const, fileKey } : null;
}
