import { useAtomMount, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PullRequestListInput } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnabledNavigationTabs } from "../layout/workspace/navigation-tabs";
import { usePullRequestListTargets } from "./usePullRequestListControls";

/** Fills an empty saved list for the scope the PRs tab opens on, so its first visit paints. */
export function PullRequestListWarmup() {
  // Until the saved filters load, the tab's scope is not known and a read could be wasted.
  const loaded = AsyncResult.isSuccess(useAtomValue(mobilePreferencesAtom));
  const enabled = useEnabledNavigationTabs().includes("pullRequests");
  return loaded && enabled ? <WarmLists /> : null;
}

function WarmLists() {
  const { targets } = usePullRequestListTargets("");
  return targets.map((target) => <WarmList key={target.environmentId} target={target} />);
}

function WarmList(props: {
  target: { readonly environmentId: EnvironmentId; readonly input: PullRequestListInput };
}) {
  useAtomMount(composerPullRequests.warmList(props.target));
  return null;
}
