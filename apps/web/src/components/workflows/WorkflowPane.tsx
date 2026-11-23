import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { workflowReferenceLabel } from "@t3tools/client-runtime/workflows";
import { EnvironmentId, ThreadId, type WorkflowRunReference } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BotIcon, Maximize2Icon, XIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import {
  activeWorkflowPaneIndex,
  closeWorkflowPaneTab,
  openWorkflowPaneTab,
  type WorkflowPaneState,
  type WorkflowPaneTab,
} from "./workflowPane.logic";
import {
  useOpenReferencePage,
  WorkflowReferenceMark,
  WorkflowReferencePanel,
} from "./WorkflowReferences";
import WorkflowThreadPane, {
  useOpenThreadPage,
  WorkflowThreadTabLabel,
} from "./WorkflowThreadPane";
import { useWorkflowThreadOpen } from "./useWorkflowThreadOpen";

/**
 * The pane beside a run: a tab per transcript or reference opened from it. Only the tab that
 * shows is mounted, so a pane with a chat and two pull requests renders one of them.
 */
export default function WorkflowPane({
  environmentId,
  runId,
  state,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: string | null;
  readonly state: WorkflowPaneState;
  readonly onChange: (next: WorkflowPaneState) => void;
}) {
  const gt = useGT();
  const detail = useEnvironmentQuery(
    runId === null ? null : serverEnvironment.workflowRun({ environmentId, input: { runId } }),
  );
  const openThreadPage = useOpenThreadPage();
  const openReferencePage = useOpenReferencePage(environmentId);
  const tabs = state.pane ?? [];
  const activeIndex = activeWorkflowPaneIndex(state);
  const active = tabs[activeIndex];
  const threadOf = (tab: Extract<WorkflowPaneTab, { thread: string }>) =>
    scopeThreadRef(
      tab.env === undefined ? environmentId : EnvironmentId.make(tab.env),
      ThreadId.make(tab.thread),
    );
  const referenceOf = (tab: Extract<WorkflowPaneTab, { kind: string }>) =>
    detail.data?.references.find(
      (reference) => reference.kind === tab.kind && reference.key === tab.key,
    ) ?? null;
  const activeReference = active === undefined || "thread" in active ? null : referenceOf(active);
  const activeThread = active !== undefined && "thread" in active ? threadOf(active) : null;
  const activeThreadLinked =
    useWorkflowThreadOpen(environmentId, activeThread?.environmentId ?? environmentId).open ===
    "linked";
  const openFull =
    active === undefined
      ? null
      : "thread" in active
        ? () => openThreadPage(threadOf(active), activeThreadLinked ? environmentId : undefined)
        : activeReference === null
          ? null
          : openReferencePage(activeReference);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 border-b ps-2 pe-2">
        <div
          role="tablist"
          aria-label={gt("Open beside the run")}
          className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto"
        >
          {tabs.map((tab, index) => (
            <div
              key={
                "thread" in tab ? `thread:${tab.env ?? ""}:${tab.thread}` : `${tab.kind}:${tab.key}`
              }
              className={cn(
                "flex max-w-56 min-w-0 shrink-0 items-center rounded-md text-xs",
                index === activeIndex
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={index === activeIndex}
                className="flex min-w-0 cursor-pointer items-center gap-1.5 py-1 ps-2 pe-1"
                onClick={() => onChange(openWorkflowPaneTab(state, tab))}
              >
                {"thread" in tab ? (
                  <>
                    <BotIcon aria-hidden className="size-3 shrink-0" />
                    <span className="truncate">
                      <WorkflowThreadTabLabel threadRef={threadOf(tab)} />
                    </span>
                  </>
                ) : (
                  <ReferenceTabLabel reference={referenceOf(tab)} fallback={tab.kind} />
                )}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={gt("Close tab")}
                onClick={() => onChange(closeWorkflowPaneTab(state, index))}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
        {openFull === null ? null : (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={
              active !== undefined && "thread" in active
                ? gt("Open as a full thread")
                : gt("Open on its own page")
            }
            onClick={openFull}
          >
            <Maximize2Icon />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={gt("Close the pane")}
          onClick={() => onChange({})}
        >
          <XIcon />
        </Button>
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {active === undefined ? null : "thread" in active ? (
          <WorkflowThreadPane
            key={`${active.env ?? ""}:${active.thread}`}
            viaEnvironmentId={environmentId}
            threadRef={threadOf(active)}
          />
        ) : activeReference !== null ? (
          <WorkflowReferencePanel
            key={`${active.kind}:${active.key}`}
            environmentId={environmentId}
            reference={activeReference}
          />
        ) : (
          <p className="p-3 text-xs text-muted-foreground" role="status">
            {detail.data === null ? gt("Loading…") : gt("This run no longer lists it.")}
          </p>
        )}
      </div>
    </div>
  );
}

function ReferenceTabLabel({
  reference,
  fallback,
}: {
  readonly reference: WorkflowRunReference | null;
  readonly fallback: string;
}) {
  if (reference === null) return <span className="truncate">{fallback}</span>;
  return (
    <>
      <WorkflowReferenceMark reference={reference} />
      <span className="truncate">{workflowReferenceLabel(reference)}</span>
    </>
  );
}
