import { machineSummaryParts } from "@t3tools/client-runtime/machine-resources";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { SettingsRow } from "./settingsLayout";

type SummaryLayout = "line" | "row";

/**
 * CPU, memory and T3 volume free space for a connected environment. The query polls only while
 * mounted, so render this only in visible rows of connected environments.
 */
export function EnvironmentMachineSummary({
  environmentId,
  layout = "line",
}: {
  readonly environmentId: EnvironmentId;
  readonly layout?: SummaryLayout;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  if (!canRead) return null;
  return <EnvironmentMachineSummaryLine environmentId={environmentId} layout={layout} />;
}

function EnvironmentMachineSummaryLine({
  environmentId,
  layout,
}: {
  readonly environmentId: EnvironmentId;
  readonly layout: SummaryLayout;
}) {
  const resources = useEnvironmentQuery(
    serverEnvironment.machineResources({ environmentId, input: {} }),
  );
  if (resources.data === null) return null;
  const parts = machineSummaryParts(resources.data);
  const line =
    parts === null
      ? "Not reported"
      : parts.map((part, index) => (
          <span key={part.text}>
            {index > 0 ? " · " : null}
            <span
              className={cn(
                part.tone === "warning" && "text-warning-foreground",
                part.tone === "danger" && "text-destructive",
              )}
            >
              {part.text}
            </span>
          </span>
        ));
  if (layout === "row") {
    return (
      <SettingsRow title="Machine" description={<span className="tabular-nums">{line}</span>} />
    );
  }
  return <span className="block truncate text-xs text-muted-foreground tabular-nums">{line}</span>;
}
