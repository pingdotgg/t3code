import { ListGhost, ConversationGhost } from "../sourceControl/ListGhosts";

export {
  PullRequestDetailGhost,
  PeopleGhost as PullRequestPeopleGhost,
  TimelineGhost as PullRequestTimelineGhost,
} from "../sourceControl/ListGhosts";

export function PullRequestListGhost(props: { rows?: number; caption?: string }) {
  return <ListGhost {...props} label="Loading pull requests" />;
}

export function PullRequestConversationGhost(props: { rows?: number }) {
  return <ConversationGhost {...props} label="Loading pull request conversation" />;
}
