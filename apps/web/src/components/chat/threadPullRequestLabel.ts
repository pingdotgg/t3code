import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { findProjectForChangeRequest, type ChangeRequestLink } from "~/lib/openPullRequestLink";

/** A bare number belongs to the thread's project; other repositories need their name. */
export function threadPullRequestLabel(
  pullRequest: ChangeRequestLink,
  threadProject: EnvironmentProject | null,
): string {
  return threadProject !== null &&
    findProjectForChangeRequest([threadProject], pullRequest) !== undefined
    ? `#${pullRequest.number}`
    : `${pullRequest.repository}#${pullRequest.number}`;
}
