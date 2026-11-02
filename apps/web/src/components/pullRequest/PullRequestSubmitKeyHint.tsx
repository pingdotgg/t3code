import { isMacPlatform } from "~/lib/utils";

import { Kbd } from "../ui/kbd";

/** The ⌘↵ / Ctrl↵ hint inside a composer's submit button, which that chord presses. */
export function PullRequestSubmitKeyHint() {
  const mac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
  return <Kbd aria-hidden>{mac ? "⌘↵" : "Ctrl ↵"}</Kbd>;
}
