import type { WorkflowLintError } from "@t3tools/contracts";
import {
  BotIcon,
  CheckSquareIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "~/components/ui/button";
import { addStep, lintErrorKey, removeStep, reorderStep } from "~/workflow/editorModel";

import { StepFields } from "./StepFields";
import {
  lintErrorMatchesStep,
  type WorkflowEditorMutation,
  type WorkflowLaneEncoded,
} from "./WorkflowEditor";

export function PipelineEditor({
  lane,
  lanes,
  lintErrors,
  disabled = false,
  onMutate,
}: {
  readonly lane: WorkflowLaneEncoded;
  readonly lanes: ReadonlyArray<WorkflowLaneEncoded>;
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
  readonly disabled?: boolean;
  readonly onMutate: WorkflowEditorMutation;
}) {
  const laneKey = String(lane.key);
  const pipeline = lane.pipeline ?? [];

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">Pipeline</h4>
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onMutate((current) => addStep(current, laneKey, "agent"))}
          >
            <BotIcon className="size-3.5" />
            Agent
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onMutate((current) => addStep(current, laneKey, "script"))}
          >
            <TerminalIcon className="size-3.5" />
            Script
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onMutate((current) => addStep(current, laneKey, "approval"))}
          >
            <CheckSquareIcon className="size-3.5" />
            Approval
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onMutate((current) => addStep(current, laneKey, "merge"))}
          >
            <GitMergeIcon className="size-3.5" />
            Merge
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onMutate((current) => addStep(current, laneKey, "pullRequest"))}
          >
            <GitPullRequestIcon className="size-3.5" />
            Pull Request
          </Button>
        </div>
      </div>
      {pipeline.length === 0 ? (
        <p className="rounded-md border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
          No pipeline steps.
        </p>
      ) : (
        <ol className="space-y-3">
          {pipeline.map((step, index) => {
            const stepKey = String(step.key);
            const stepLintErrors = lintErrors.filter((lintError) =>
              lintErrorMatchesStep(lintError, laneKey, stepKey),
            );
            return (
              <li key={stepKey} className="rounded-md border border-border/70 bg-card/35 p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{stepKey}</p>
                    <p className="text-xs text-muted-foreground">{step.type}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Move ${stepKey} up`}
                      disabled={disabled || index === 0}
                      onClick={() =>
                        onMutate((current) => reorderStep(current, laneKey, index, index - 1))
                      }
                    >
                      <ChevronUpIcon className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Move ${stepKey} down`}
                      disabled={disabled || index === pipeline.length - 1}
                      onClick={() =>
                        onMutate((current) => reorderStep(current, laneKey, index, index + 1))
                      }
                    >
                      <ChevronDownIcon className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${stepKey}`}
                      disabled={disabled}
                      onClick={() => onMutate((current) => removeStep(current, laneKey, stepKey))}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
                {stepLintErrors.length > 0 ? (
                  <ul className="mb-3 rounded-md border border-warning/45 bg-warning/8 p-2 text-sm text-warning-foreground">
                    {stepLintErrors.map((lintError) => (
                      <li key={lintErrorKey(lintError)}>{lintError.message}</li>
                    ))}
                  </ul>
                ) : null}
                <StepFields
                  laneKey={laneKey}
                  lanes={lanes}
                  step={step}
                  disabled={disabled}
                  onMutate={onMutate}
                />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
