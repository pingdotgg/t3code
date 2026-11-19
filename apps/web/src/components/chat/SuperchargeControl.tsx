import type { ScopedThreadRef, SuperchargeRun } from "@t3tools/contracts";
import { ZapIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { superchargeEnvironment } from "../../state/supercharge";

function superchargeRunLabel(run: SuperchargeRun): string {
  if (run.stop) return `Supercharge stopped: ${run.stop.message}`;
  const passed = run.checks.filter((check) => check.status === "pass").length;
  return `${run.phase} · round ${run.iteration + 1}/${run.limits.maxIterations + 1}${
    run.checks.length > 0 ? ` · ${passed}/${run.checks.length} checks` : ""
  }`;
}

/** A one-line status above the composer while a Supercharge run is going or just ended. */
export function SuperchargeRunStatus({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const query = useEnvironmentQuery(
    superchargeEnvironment.state({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const run = query.data?.run ?? null;
  if (run === null || query.data?.config.preset === "off") return null;
  const tone = run.stop
    ? run.stop.reason === "checks-passed"
      ? "text-success"
      : "text-warning"
    : "text-primary";
  return (
    <div
      className={cn("flex items-center gap-1.5 px-1 pb-1 text-xs", tone)}
      data-supercharge-status
      aria-live="polite"
    >
      <ZapIcon className="size-3" />
      <span className="truncate">{superchargeRunLabel(run)}</span>
      {run.checks.length > 0 ? (
        <span className="ms-auto flex gap-0.5" aria-hidden="true">
          {run.checks.map((check) => (
            <span
              key={check.name}
              className={cn(
                "size-1.5 rounded-full",
                check.status === "pass"
                  ? "bg-success"
                  : check.status === "fail"
                    ? "bg-destructive"
                    : "bg-muted-foreground/50",
              )}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}
