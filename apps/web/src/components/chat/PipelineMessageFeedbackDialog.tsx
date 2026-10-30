import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildCoordinatorFeedbackMessage,
  pipelineFeedbackRoutes,
  pipelineStepPosition,
  stepName,
} from "@t3tools/client-runtime/pipeline-run-presentation";
import type { EnvironmentId, PipelineRun, ScopedThreadRef } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Textarea } from "../ui/textarea";
import { getComposerPromptLengthValidationMessage } from "./composerSubmission";
import { openPipelineCoordinator } from "./openPipelineCoordinator";
import { usePipelineCoordinatorSend } from "./usePipelineCoordinatorSend";
import { usePipelineRevise } from "./usePipelineRevise";

const COORDINATOR_ROUTE = "coordinator";

/**
 * Feedback on a quoted excerpt from a step's thread. "Coordinator decides" posts it to the run's
 * coordinator chat; a step receives it directly, bypassing the coordinator.
 */
export function PipelineMessageFeedbackDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly run: PipelineRun;
  /** The step whose thread the quote came from. */
  readonly sourceStepId: string;
  /** The thread the quote came from; its Coordinator tab opens after a coordinator send. */
  readonly stepThreadRef: ScopedThreadRef;
  readonly quote: string;
  readonly onClose: () => void;
}) {
  const { environmentId, run, stepThreadRef } = props;
  const navigate = useNavigate();
  const { canRevise, revise } = usePipelineRevise(environmentId);
  const sendToCoordinator = usePipelineCoordinatorSend(environmentId, run.parentThreadId);
  const [route, setRoute] = useState(COORDINATOR_ROUTE);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const sourceStep = run.steps.find((step) => step.stepId === props.sourceStepId);
  const routes = pipelineFeedbackRoutes(run);
  const targetStepIndex = route === COORDINATOR_ROUTE ? null : Number(route);
  const coordinatorMessage = buildCoordinatorFeedbackMessage({
    quote: props.quote,
    sourceStepName: pipelineStepPosition(run, props.sourceStepId)?.name ?? props.sourceStepId,
    sourceStepLink: formatThreadLink(stepThreadRef),
    note,
  });
  const lengthMessage = getComposerPromptLengthValidationMessage(
    targetStepIndex === null ? coordinatorMessage : note,
  );
  const laterStepRunning =
    targetStepIndex !== null && run.status === "running" && run.currentStepIndex > targetStepIndex;

  const submit = async () => {
    if (sending || note.trim() === "" || lengthMessage !== null) return;
    setSending(true);
    let sent: boolean;
    if (targetStepIndex === null) {
      sent = await sendToCoordinator(coordinatorMessage);
      if (sent) openPipelineCoordinator(stepThreadRef);
    } else {
      const revised = await revise({
        runId: run.id,
        stepIndex: targetStepIndex,
        feedback: note,
        quote: props.quote,
        ...(sourceStep === undefined ? {} : { sourceStepId: sourceStep.stepId }),
      });
      sent = revised !== null;
      const revisedThreadId = revised?.steps[targetStepIndex]?.childThreadId ?? null;
      if (sent) {
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Feedback sent to ${stepName(run, targetStepIndex)}`,
            description: "It fixes its work, then the later steps redo theirs.",
            ...(revisedThreadId === null
              ? {}
              : {
                  actionProps: {
                    children: "Open",
                    onClick: () => {
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(environmentId, revisedThreadId),
                        ),
                      });
                    },
                  },
                }),
          }),
        );
      }
    }
    setSending(false);
    if (sent) props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription>
              Let the coordinator route it, or send it to one step.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <blockquote className="m-0 max-h-32 overflow-y-auto border-s-2 border-border ps-2 text-xs whitespace-pre-wrap text-muted-foreground">
                {props.quote}
              </blockquote>
              <Textarea
                autoFocus
                aria-label="Note"
                placeholder="What should change?"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={4}
              />
              {lengthMessage === null ? null : (
                <p className="text-xs text-destructive-foreground" role="alert">
                  {lengthMessage}
                </p>
              )}
              <RadioGroup
                aria-label="Send to"
                value={route}
                onValueChange={(value) => setRoute(String(value))}
              >
                <label className="flex items-center gap-2 text-sm">
                  <Radio value={COORDINATOR_ROUTE} />
                  Coordinator decides
                </label>
                {routes.map((option) => {
                  const disabled = option.disabled || !canRevise;
                  return (
                    <label
                      key={option.stepIndex}
                      className="flex items-center gap-2 text-sm aria-disabled:opacity-50"
                      aria-disabled={disabled}
                    >
                      <Radio value={String(option.stepIndex)} disabled={disabled} />
                      <span className="min-w-0 truncate">{option.name}</span>
                      {option.hint === null ? null : (
                        <span className="text-xs text-muted-foreground">{option.hint}</span>
                      )}
                    </label>
                  );
                })}
              </RadioGroup>
              {targetStepIndex === null ? null : (
                <p className="text-xs text-muted-foreground">
                  {stepName(run, targetStepIndex)} fixes its work in its own thread, then every
                  later step redoes its work.
                  {laterStepRunning ? " The step that is running now is stopped first." : ""}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={sending || note.trim() === "" || lengthMessage !== null}
            >
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
