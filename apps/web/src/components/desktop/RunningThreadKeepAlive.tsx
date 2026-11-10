import { useAtomMount } from "@effect/atom-react";

import { runningThreadKeepAliveAtom } from "../../state/threads";

export function RunningThreadKeepAlive() {
  useAtomMount(runningThreadKeepAliveAtom);
  return null;
}
