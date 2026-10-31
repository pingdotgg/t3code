import { parseThreadPath } from "@t3tools/shared/threadDeepLinks";
export function hostedThreadLinkAction(
  appPath: string,
  ready: boolean,
  environmentIds: ReadonlyArray<string>,
) {
  const url = new URL(appPath, "https://app.invalid");
  const ref = parseThreadPath(url.pathname);
  if (!ref || url.searchParams.has("prompt")) return "choose";
  if (!ready) return "wait";
  // Desktop may hand an unknown thread back here; never automatically send it back again.
  return environmentIds.includes(ref.environmentId) ? "continue" : "choose-manually";
}
