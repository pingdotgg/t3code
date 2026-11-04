import { hostResourcesSummary, isHostDiskLow } from "@t3tools/client-runtime/host-summary";
import type { EnvironmentId } from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";

/** Mount only while visible: each mount samples the host once and the query drops on unmount. */
export function EnvironmentHostSummary({
  environmentId,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly className?: string;
}) {
  const { data } = useEnvironmentQuery(
    serverEnvironment.hostResources({ environmentId, input: {} }),
  );
  if (!data) return null;
  const summary = hostResourcesSummary(data);
  if (!summary) return null;
  return (
    <span
      className={cn(
        "block truncate",
        className,
        (isHostDiskLow(data) || data.rebootRequired) && "text-warning",
      )}
    >
      {summary}
    </span>
  );
}
