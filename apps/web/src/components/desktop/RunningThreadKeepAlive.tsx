import { useAtomMount } from "@effect/atom-react";

import { runningThreadKeepAliveAtom } from "../../state/threads";

/**
 * Desktop only. Keeps each running thread subscribed in every enabled
 * environment, so opening one shows live state without a replay or a sync
 * status flash. It mounts the atom without reading it, so thread updates
 * never re-render.
 */
export function RunningThreadKeepAlive() {
  useAtomMount(runningThreadKeepAliveAtom);
  return null;
}
