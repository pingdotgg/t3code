import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRight, Loader, Wrench } from "lucide-react";

import type { ToolStep } from "./timeline";
import { WorkLog } from "./WorkLog";

/** A stretch of tool calls folded into one line, which opens to the work log. */
export function WorkRow({
  steps,
  environmentId,
}: {
  steps: ReadonlyArray<ToolStep>;
  environmentId: EnvironmentId;
}) {
  const running = steps.find((step) => step.running);
  const failed = steps.filter((step) => step.failed).length;
  return (
    <details className="group text-muted" data-testid="work-row">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 hover:text-fg">
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        {running === undefined ? (
          <Wrench className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <Loader className="size-3.5 shrink-0 animate-spin" aria-hidden />
        )}
        <span className="min-w-0 truncate">
          {running?.label ?? `${steps.length} ${steps.length === 1 ? "tool call" : "tool calls"}`}
        </span>
        {failed > 0 && <span className="shrink-0 text-red-400">{failed} failed</span>}
      </summary>
      <WorkLog steps={steps} environmentId={environmentId} />
    </details>
  );
}
