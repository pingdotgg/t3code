import { useAtomMount } from "@effect/atom-react";
import type { EnvironmentId, PullRequestListInput } from "@t3tools/contracts";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";

import { readPullRequestListPreferences } from "./pullRequestListPreferences";
import { pullRequestBaselineTargets, usePullRequestScope } from "./usePullRequestListView";

/** Fills an empty saved list for the scope the PRs page opens on, so its first visit paints. */
export function PullRequestListWarmup() {
  const [preferences] = useState(readPullRequestListPreferences);
  const scope = usePullRequestScope(preferences);
  // Before the projects load the page asks with another key, which would cost a second read.
  if (!scope.projectsKnown) return null;
  return pullRequestBaselineTargets(preferences, scope).map((target) => (
    <WarmList key={target.environmentId} target={target} />
  ));
}

function WarmList(props: {
  target: { readonly environmentId: EnvironmentId; readonly input: PullRequestListInput };
}) {
  useAtomMount(pullRequestEnvironment.warmList(props.target));
  return null;
}
