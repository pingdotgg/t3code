import { ThreadPullRequestsPanel } from "~/components/pullRequest/ThreadPullRequestsPanel";

import { usePanelHost } from "../panelHost";

export default function PullRequestsSidePanel() {
  return <ThreadPullRequestsPanel threadRef={usePanelHost().threadRef} />;
}
