/**
 * Open an http(s) URL in the browser that is already showing this page.
 *
 * A real `<a target="_blank">` click stays inside the user gesture, so the tab
 * lands in the current browser instead of being popup-blocked or handed to a
 * different OS handler after an async menu. Desktop still intercepts `_blank`
 * and routes it through `openExternal`.
 */
export function openUrlInHostBrowser(url: string): boolean {
  let href: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    href = parsed.href;
  } catch {
    return false;
  }

  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  return true;
}
