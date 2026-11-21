import { useAtomMount } from "@effect/atom-react";

import { runningThreadKeepAliveAtom } from "../../state/threads";
import { definePluginComponent } from "~/plugins/features";

export const RunningThreadKeepAlive = definePluginComponent(
  "component:components/desktop/RunningThreadKeepAlive/RunningThreadKeepAlive",
  PluginOriginalRunningThreadKeepAlive,
);

function PluginOriginalRunningThreadKeepAlive() {
  useAtomMount(runningThreadKeepAliveAtom);
  return null;
}
