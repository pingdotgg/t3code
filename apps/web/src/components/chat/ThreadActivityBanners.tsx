import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderGoal,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  presentPendingBackgroundWork,
  presentProviderGoal,
} from "@t3tools/client-runtime/state/thread-execution";
import { childThreadInputsTitle } from "@t3tools/client-runtime/state/threads";
import { GitBranchIcon, MessageCircleIcon, ShieldQuestionIcon, TargetIcon } from "lucide-react";
import { Fragment } from "react";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { ThreadNowItem } from "./ThreadNow";

/** Subagents waiting on the user, unless the parent is itself waiting on them. */
export function childInputNowItem(input: {
  readonly childThreadInputs: ReadonlyArray<EnvironmentThreadShell>;
  readonly parentAwaitingUser: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ThreadNowItem | null {
  const { childThreadInputs, onOpenThread } = input;
  const first = childThreadInputs[0];
  if (!first || input.parentAwaitingUser) return null;
  return {
    id: `child-input:${first.id}`,
    // The only line at the end of the timeline that needs you gets the info color.
    icon: first.hasPendingApprovals ? (
      <ShieldQuestionIcon className="text-info-foreground" />
    ) : (
      <MessageCircleIcon className="text-info-foreground" />
    ),
    title: childThreadInputsTitle(childThreadInputs),
    description: childThreadInputs.map((child, index) => (
      <Fragment key={child.id}>
        {index > 0 ? " " : null}
        <span className="whitespace-nowrap">
          <InlineButton tone="muted" onClick={() => onOpenThread(child.id)}>
            {child.title}
          </InlineButton>
          {index < childThreadInputs.length - 1 ? "," : null}
        </span>
      </Fragment>
    )),
    actions: (
      <InlineButton onClick={() => onOpenThread(first.id)}>
        {first.hasPendingApprovals ? "Open approval" : "Open question"}
      </InlineButton>
    ),
  };
}

/** The thread's goal, for the end of the timeline. */
export function goalNowItem(input: {
  readonly threadId: ThreadId;
  readonly goal: OrchestrationV2ProviderGoal;
  readonly isWorking: boolean;
  readonly onSendCommand: (text: string, failureMessage: string) => Promise<void>;
}): ThreadNowItem {
  const { isWorking, onSendCommand } = input;
  const presentation = presentProviderGoal(input.goal, isWorking);
  return {
    id: `goal:${input.threadId}`,
    icon: <TargetIcon />,
    title:
      presentation.usage === null
        ? presentation.title
        : `${presentation.title} · ${presentation.usage}`,
    description: presentation.objective,
    // Clear stops goal work; Resume would stop unrelated work, so it waits.
    actions: (
      <>
        {presentation.canResume && !isWorking ? (
          <>
            <InlineButton
              onClick={() => void onSendCommand("/goal resume", "Failed to resume goal.")}
            >
              Resume
            </InlineButton>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <InlineButton
          tone="muted"
          onClick={() => void onSendCommand("/goal clear", "Failed to clear goal.")}
        >
          Clear
        </InlineButton>
      </>
    ),
  };
}

/** Background commands and subagents, for the end of the timeline. */
export function backgroundWorkNowItem(input: {
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly stopDisabled: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ThreadNowItem | null {
  const { onOpenThread } = input;
  const presentation = presentPendingBackgroundWork(input.tasks);
  if (presentation === null) return null;
  return {
    id: `background-work:${input.threadId}`,
    icon: (
      <span
        className={cn(
          "size-1.5 rounded-full",
          presentation.waiting ? "bg-foreground" : "bg-muted-foreground",
        )}
        aria-hidden="true"
      />
    ),
    title: presentation.title,
    description:
      presentation.items.length === 1 && presentation.items[0]?.childThreadId === undefined
        ? undefined
        : presentation.items.map((item, index) => {
            const childThreadId = item.childThreadId;
            const separator = index < presentation.items.length - 1 ? "," : null;
            return (
              <Fragment key={item.taskId}>
                {index > 0 ? " " : null}
                {childThreadId === undefined ? (
                  <>
                    {item.label}
                    {separator}
                  </>
                ) : (
                  <span className="whitespace-nowrap">
                    <InlineButton
                      tone="muted"
                      aria-label={`${presentation.items.length === 1 ? "Show" : "Open"} subagent ${item.label}`}
                      onClick={() => onOpenThread(childThreadId)}
                    >
                      {presentation.items.length === 1 ? "Show" : item.label}
                    </InlineButton>
                    {separator}
                  </span>
                )}
              </Fragment>
            );
          }),
    actions: (
      <InlineButton disabled={input.stopDisabled} onClick={() => void input.onStop()}>
        {input.stopping ? "Stopping..." : "Stop"}
      </InlineButton>
    ),
  };
}

/** The local checkout moved off the branch this thread last ran on. */
export function branchMismatchBannerItem(input: {
  readonly mismatchKey: string;
  readonly mismatch: { readonly threadBranch: string; readonly currentBranch: string };
  readonly restoreDisabled: boolean;
  readonly restoring: boolean;
  readonly onRestore: () => void;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  const { mismatch } = input;
  return {
    id: `branch-mismatch:${input.mismatchKey}`,
    variant: "info",
    icon: <GitBranchIcon />,
    title: (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-normal text-muted-foreground">Branch changed from</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <code className="min-w-0 truncate font-medium text-foreground">
                {mismatch.threadBranch}
              </code>
            }
          />
          <TooltipPopup side="top">
            This thread last ran on {mismatch.threadBranch}. Sending will continue on{" "}
            {mismatch.currentBranch}.
          </TooltipPopup>
        </Tooltip>
      </span>
    ),
    actions: (
      <Button size="xs" variant="ghost" disabled={input.restoreDisabled} onClick={input.onRestore}>
        {input.restoring ? "Restoring..." : "Restore branch"}
      </Button>
    ),
    dismissLabel: "Dismiss branch change notice",
    onDismiss: input.onDismiss,
  };
}
