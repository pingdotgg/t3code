import { ActivityUnavailableState } from "../sourceControl/ActivityUnavailableState";

export function PullRequestActivityUnavailableState(props: {
  error: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  return <ActivityUnavailableState {...props} title="Could not load pull request activity" />;
}
