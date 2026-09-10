import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";

import { UnavailableState } from "../sourceControl/UnavailableState";
import { Button } from "../ui/button";

export function PullRequestsUnavailableState({
  title = "Could not load pull requests",
  error,
  onRetry,
  refreshing = false,
  gitHubUrl,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
  refreshing?: boolean;
  gitHubUrl?: string;
}) {
  return (
    <UnavailableState
      icon={<GitPullRequestIcon />}
      title={title}
      error={error}
      onRetry={onRetry}
      refreshing={refreshing}
      action={
        gitHubUrl ? (
          <Button
            size="sm"
            variant="outline"
            render={<a href={gitHubUrl} target="_blank" rel="noopener noreferrer" />}
          >
            <ExternalLinkIcon aria-hidden className="size-3.5" />
            Open on GitHub
          </Button>
        ) : null
      }
    />
  );
}
