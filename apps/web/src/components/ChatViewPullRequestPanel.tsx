import type { EnvironmentId } from "@t3tools/contracts";
import type { ComponentProps } from "react";

import type { EnvironmentPresentation } from "../state/environments";
import { PullRequestDetailPanel } from "./pullRequest/PullRequestDetailPanel";
import { PullRequestDetailGhost } from "./pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "./pullRequest/PullRequestsUnavailableState";

export function ChatViewPullRequestPanel({
  environmentById,
  ...props
}: ComponentProps<typeof PullRequestDetailPanel> & {
  environmentById: ReadonlyMap<EnvironmentId, Pick<EnvironmentPresentation, "serverConfig">>;
}) {
  const serverConfig = environmentById.get(props.environmentId)?.serverConfig ?? null;
  if (serverConfig === null) return <PullRequestDetailGhost />;
  if (serverConfig.environment.capabilities.pullRequests !== true) {
    return (
      <PullRequestsUnavailableState
        title="Pull requests unavailable"
        error="Update this environment's T3 Code server to browse pull requests."
      />
    );
  }
  return <PullRequestDetailPanel {...props} />;
}
