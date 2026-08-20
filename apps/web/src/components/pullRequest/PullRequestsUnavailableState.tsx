import { GitPullRequestIcon } from "lucide-react";

import { UnavailableState } from "../sourceControl/UnavailableState";

export function PullRequestsUnavailableState({
  title = "Could not load pull requests",
  error,
  onRetry,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
}) {
  return (
    <UnavailableState icon={<GitPullRequestIcon />} title={title} error={error} onRetry={onRetry} />
  );
}
