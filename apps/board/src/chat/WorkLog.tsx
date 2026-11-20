import type { EnvironmentId } from "@t3tools/contracts";

import type { ToolStep } from "./timeline";
import { WorkStep } from "./WorkStep";

/** Every tool call of a stretch, each with its icon and label, and on open its command, output, changed file, and error. */
export function WorkLog({
  steps,
  environmentId,
}: {
  steps: ReadonlyArray<ToolStep>;
  environmentId: EnvironmentId;
}) {
  return (
    <ul className="mt-1 flex min-w-0 flex-col gap-0.5">
      {steps.map((step) => (
        <WorkStep key={step.id} step={step} environmentId={environmentId} />
      ))}
    </ul>
  );
}
