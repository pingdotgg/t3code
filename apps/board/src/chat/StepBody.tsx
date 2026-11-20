import type { EnvironmentId } from "@t3tools/contracts";
import { CircleAlert } from "lucide-react";

import { CodeBody } from "./CodeBody";
import { diffCounts, useStepDetail } from "./stepDetail";
import { StepOutput } from "./StepOutput";
import type { ToolStep } from "./timeline";

export function StepBody({
  step,
  environmentId,
}: {
  step: ToolStep;
  environmentId: EnvironmentId;
}) {
  const detail = useStepDetail(environmentId, step);
  const counts =
    step.file === null
      ? null
      : step.file.additions !== null && step.file.deletions !== null
        ? { additions: step.file.additions, deletions: step.file.deletions }
        : detail.diff === null
          ? null
          : diffCounts(detail.diff);
  return (
    <div
      className="mt-1 mb-1.5 ml-6 flex min-w-0 flex-col gap-1.5"
      data-testid="step-body"
      data-wrap="true"
    >
      {step.input !== null && step.family === "command" && (
        <CodeBody code={step.input} language="bash" streaming={false} />
      )}
      {step.input !== null && step.family !== "command" && step.family !== "agent" && (
        <CodeBody code={step.input} language="json" streaming={false} />
      )}
      {step.input !== null && step.family === "agent" && (
        <p className="break-words whitespace-pre-wrap text-muted">{step.input}</p>
      )}
      {step.file !== null && (
        <p className="flex items-center gap-2 font-mono text-[11px]" data-testid="step-file">
          <span className="min-w-0 truncate text-fg">{step.file.name}</span>
          {counts !== null && (
            <>
              <span className="shrink-0 text-emerald-400">+{counts.additions}</span>
              <span className="shrink-0 text-red-400">-{counts.deletions}</span>
            </>
          )}
        </p>
      )}
      {detail.diff !== null && detail.diff !== "" && (
        <CodeBody code={detail.diff} language="diff" streaming={false} />
      )}
      {detail.output !== null && detail.output !== "" && step.family !== "edit" && (
        <StepOutput text={detail.output} failed={step.failed} />
      )}
      {step.family === "edit" && step.failed && detail.output !== null && (
        <StepOutput text={detail.output} failed />
      )}
      {step.failed && (
        <p role="alert" className="flex items-center gap-1.5 text-red-400" data-testid="step-error">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {step.exitCode !== null && step.exitCode !== 0
            ? `Failed with exit code ${step.exitCode}`
            : "The call failed"}
        </p>
      )}
      {detail.state === "loading" && <p className="text-faint">Loading output</p>}
      {detail.state === "unavailable" && (
        <p className="text-faint">Output is no longer available</p>
      )}
    </div>
  );
}
