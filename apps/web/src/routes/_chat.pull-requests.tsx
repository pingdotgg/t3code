import { createFileRoute } from "@tanstack/react-router";

import { PullRequestsPage } from "../components/pullRequest/PullRequestsPage";
import { validatePullRequestsSearch } from "../components/pullRequest/usePullRequestListView";

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: validatePullRequestsSearch,
  component: PullRequestsPage,
});
