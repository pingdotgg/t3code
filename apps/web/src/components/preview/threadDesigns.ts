import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { designPathFromUrl } from "@t3tools/shared/designPrompt";

export function threadDesigns(
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  httpBaseUrl: string | null,
) {
  const designs = new Map<string, { tabId: string; path: string; title: string; url: string }>();
  if (!httpBaseUrl) return [];
  for (const session of Object.values(sessions)) {
    const nav = session.navStatus;
    if (nav._tag === "Idle") continue;
    const path = designPathFromUrl(nav.url, httpBaseUrl);
    if (!path) continue;
    designs.set(path, {
      tabId: session.tabId,
      path,
      url: nav.url,
      title: nav._tag === "Success" && nav.title ? nav.title : (path.split("/").at(-1) ?? path),
    });
  }
  return [...designs.values()];
}
