import { CircleDotIcon } from "lucide-react";

import { UnavailableState } from "../sourceControl/UnavailableState";

export function IssuesUnavailableState({
  title = "Could not load issues",
  error,
  onRetry,
  refreshing = false,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
  refreshing?: boolean;
}) {
  return (
    <UnavailableState
      icon={<CircleDotIcon />}
      title={title}
      error={error}
      onRetry={onRetry}
      refreshing={refreshing}
    />
  );
}
