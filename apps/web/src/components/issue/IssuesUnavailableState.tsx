import { CircleDotIcon } from "lucide-react";

import { UnavailableState } from "../sourceControl/UnavailableState";

export function IssuesUnavailableState({
  title = "Could not load issues",
  error,
  onRetry,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
}) {
  return (
    <UnavailableState icon={<CircleDotIcon />} title={title} error={error} onRetry={onRetry} />
  );
}
