import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pipelineRunStateLabel, stepName } from "@t3tools/client-runtime/pipeline-run-presentation";
import { pipelineProgressSegments } from "@t3tools/client-runtime/state/pipeline-nesting";
import type { PipelineRun, PipelineRunSummary, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { lazy, memo, Suspense, useRef } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { useEnvironmentQuery } from "../../state/query";
import { useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { PipelineProgressBar } from "../PipelineProgressBar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundThreadContext, EmbeddedChatContext } from "./backgroundThread";
import type { ChatComposerHandle } from "./ChatComposer";

// ChatView renders this panel, so it loads lazily to keep the import cycle out of module setup.
const ChatView = lazy(() => import("../ChatView"));

/** The progress bar's input: a full run carries everything a live-run summary does. */
function summarizeRun(run: PipelineRun): PipelineRunSummary {
  return {
    id: run.id,
    parentThreadId: run.parentThreadId,
    name: run.definition.name,
    status: run.status,
    pauseReason: run.pauseReason,
    currentStepIndex: run.currentStepIndex,
    steps: run.steps.map((step) => ({
      stepId: step.stepId,
      name: stepName(run, step.index),
      status: step.status,
      childThreadId: step.childThreadId,
    })),
  };
}

/**
 * The run's coordinator chat inside a step's thread. It is the parent thread's own conversation
 * and composer, so it stays in sync with the run's main page, and it is subscribed only while the
 * tab is open.
 */
export const PipelineCoordinatorPanel = memo(function PipelineCoordinatorPanel(props: {
  readonly stepThreadRef: ScopedThreadRef;
  /** The step's diff panel and terminal, which the embedded chat uses in place of its own. */
  readonly parentPanel: SideChatParentPanel;
}) {
  const { environmentId, threadId } = props.stepThreadRef;
  const navigate = useNavigate();
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const runId = useQuietThreadShell(props.stepThreadRef)?.pipeline?.runId ?? null;
  const query = useEnvironmentQuery(
    runId === null ? null : serverEnvironment.pipelineRunLive({ environmentId, input: { runId } }),
  );
  const run = query.data?.run ?? null;
  const parentRef = run === null ? null : scopeThreadRef(environmentId, run.parentThreadId);
  const parentExists = useQuietThreadShell(parentRef) !== null;
  if (run === null || parentRef === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {query.error ?? "Loading pipeline run..."}
      </p>
    );
  }
  const segments = pipelineProgressSegments(summarizeRun(run), [], () => "ready").map(
    (segment, index) => ({
      stepId: segment.stepId,
      label: segment.label,
      status: segment.status,
      threadId: run.steps[index]?.childThreadId ?? null,
    }),
  );
  const currentIndex = run.currentStepIndex;
  const openThread = (target: ScopedThreadRef) =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pipeline-coordinator-panel">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border/60 px-3 py-2">
        <div className="flex">
          <PipelineProgressBar
            segments={segments}
            tooltipSide="left"
            onOpenStep={(stepThreadId) => openThread(scopeThreadRef(environmentId, stepThreadId))}
          />
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="min-w-0 cursor-pointer truncate text-start text-xs text-muted-foreground hover:text-foreground"
                onClick={() => openThread(parentRef)}
              />
            }
          >
            Step {currentIndex + 1}/{run.steps.length} · {stepName(run, currentIndex)} ·{" "}
            {pipelineRunStateLabel(run)}
          </TooltipTrigger>
          <TooltipPopup side="left">Open the run's main page</TooltipPopup>
        </Tooltip>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col" data-step-thread={threadId}>
        {parentExists ? (
          <BackgroundThreadContext value>
            <EmbeddedChatContext value>
              <ComposerHandleContext value={composerRef}>
                <Suspense fallback={null}>
                  <ChatView
                    key={run.parentThreadId}
                    environmentId={environmentId}
                    threadId={run.parentThreadId}
                    routeKind="server"
                    embedded={props.parentPanel}
                  />
                </Suspense>
              </ComposerHandleContext>
            </EmbeddedChatContext>
          </BackgroundThreadContext>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            The coordinator chat is not available.
          </p>
        )}
      </div>
    </div>
  );
});
