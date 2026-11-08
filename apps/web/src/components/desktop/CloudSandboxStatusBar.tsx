import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { cloudSandboxStatusAtom } from "~/connection/cloudSandbox";
import { useEnvironmentQuery } from "~/state/query";
import { usePreparedConnection } from "~/state/session";

export function CloudSandboxStatusBar({ environmentId }: { environmentId: EnvironmentId }) {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const knownSandbox = prepared?.target._tag === "CloudSandboxConnectionTarget";
  const query = useEnvironmentQuery(cloudSandboxStatusAtom(environmentId));
  const context = query.data;
  if (context === null && !knownSandbox) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap gap-3 border-b px-4 py-1 text-xs text-muted-foreground"
    >
      <span>
        Cloud sandbox ·{" "}
        {context !== null
          ? context.sandbox.state
          : query.isPending
            ? "…"
            : "Controller unavailable"}
      </span>
      {context?.sandbox.autoStopDeadline ? (
        <span>Auto-stop {new Date(context.sandbox.autoStopDeadline).toLocaleTimeString()}</span>
      ) : null}
      <span>
        {context?.usage
          ? `$${context.usage.listRateUsdPerHour}/h list-rate estimate`
          : "Rate unavailable"}
      </span>
    </div>
  );
}
