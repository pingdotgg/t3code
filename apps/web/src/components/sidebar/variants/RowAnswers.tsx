import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { fullAccessOverrideExplanation } from "@t3tools/client-runtime/state/thread-requests";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useState, type MouseEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentScope } from "../../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { ComposerPendingApprovalActions } from "../../chat/ComposerPendingApprovalActions";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

const stopRowActivation = (event: MouseEvent) => event.stopPropagation();

function AnswerBody(props: {
  detail: string;
  inline: boolean;
  mono?: boolean;
  note?: string | null;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <>
      {props.inline ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <p
                data-answer-detail
                className={cn(
                  "min-w-0 flex-1 truncate text-2xs text-muted-foreground",
                  props.mono && "font-mono",
                )}
              />
            }
          >
            {props.detail}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.detail}</TooltipPopup>
        </Tooltip>
      ) : (
        <p
          className={cn(
            "max-h-24 overflow-y-auto wrap-break-word whitespace-pre-wrap text-xs text-foreground",
            props.mono && "font-mono",
          )}
        >
          {props.detail}
        </p>
      )}
      {props.note ? (
        <p className={cn("text-xs text-muted-foreground", props.inline && "order-last basis-full")}>
          {props.note}
        </p>
      ) : null}
      <div className="flex max-w-full min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5">
        {props.children}
      </div>
      {props.error !== null ? (
        <p
          role="alert"
          className={cn("text-xs text-error-foreground", props.inline && "order-last basis-full")}
        >
          {props.error}
        </p>
      ) : null}
    </>
  );
}

/** The thread's first open request with its answer buttons, sent through `runtime-request.respond`. */
function RowAnswerContent(props: {
  thread: EnvironmentThreadShell;
  onOpenThread: (() => void) | null;
}) {
  const { thread, onOpenThread } = props;
  const inline = onOpenThread === null;
  const pending = useAtomValue(
    environmentThreadDetails.pendingRequestsAtom(scopeThreadRef(thread.environmentId, thread.id)),
  );
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const respondApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (result: Awaited<ReturnType<typeof respondApproval>>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not send the answer.");
    }
    setResponding(false);
    return result;
  };

  const approval = pending?.approvals[0] ?? null;
  if (approval !== null) {
    return (
      <AnswerBody
        detail={approval.detail || approval.requestKind}
        inline={inline}
        mono
        note={
          approval.responseCapability !== "live"
            ? "The provider process is gone. Open the thread to restart it."
            : approval.fullAccessOverride
              ? fullAccessOverrideExplanation(approval.fullAccessOverride)
              : null
        }
        error={error}
      >
        <ComposerPendingApprovalActions
          requestId={approval.requestId}
          isResponding={responding}
          canRespond={approval.responseCapability === "live"}
          disabled={!canOperate}
          options={approval.options}
          onRespondToApproval={async (requestId, decision) => {
            setResponding(true);
            setError(null);
            return finish(
              await respondApproval({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, requestId, decision },
              }),
            );
          }}
        />
      </AnswerBody>
    );
  }

  const input = pending?.userInputs[0] ?? null;
  const question = input?.questions.length === 1 ? (input.questions[0] ?? null) : null;
  if (
    input === null ||
    question === null ||
    question.multiSelect ||
    question.options.length === 0 ||
    input.responseCapability !== "live"
  ) {
    return pending !== null && onOpenThread !== null ? (
      <AnswerBody detail="This needs the full thread to answer." inline={inline} error={null}>
        <Button size="xs" variant="outline" onClick={onOpenThread}>
          Open thread
        </Button>
      </AnswerBody>
    ) : null;
  }
  return (
    <AnswerBody detail={question.question} inline={inline} error={error}>
      {question.options.map((option) => {
        const button = (
          <Button
            key={option.label}
            size="xs"
            variant="outline"
            disabled={!canOperate || responding}
            onClick={async () => {
              setResponding(true);
              setError(null);
              finish(
                await respondInput({
                  environmentId: thread.environmentId,
                  input: {
                    threadId: thread.id,
                    requestId: input.requestId,
                    answers: { [question.id]: option.value ?? option.label },
                  },
                }),
              );
            }}
          >
            <span className="max-w-40 truncate">{option.label}</span>
          </Button>
        );
        return option.description ? (
          <Tooltip key={option.label}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.description}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
    </AnswerBody>
  );
}

/** Detailed: on line 2 of a row, or under a worker's title. */
export function InlineRowAnswers(props: { thread: EnvironmentThreadShell; className?: string }) {
  return (
    <div
      role="group"
      aria-label={`Answer ${props.thread.title} without opening it`}
      data-row-answers
      onClick={stopRowActivation}
      onDoubleClick={stopRowActivation}
      className={cn(
        "-my-[0.046875rem] flex min-w-0 cursor-default flex-wrap items-center justify-end gap-1 empty:hidden",
        props.className,
      )}
    >
      <RowAnswerContent thread={props.thread} onOpenThread={null} />
    </div>
  );
}

/** Slim: the pill opens the answers, so the rows below never move. */
export function RowAnswersPopover(props: {
  thread: EnvironmentThreadShell;
  label: string;
  className: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenThread: () => void;
}) {
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${props.label}: answer without opening the thread`}
            onClick={stopRowActivation}
            onDoubleClick={stopRowActivation}
            className={cn(
              "relative cursor-pointer outline-none after:absolute after:-inset-y-1 after:inset-x-0 hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              props.className,
            )}
          />
        }
      >
        <span className="sidebar-row-pill-word">{props.label}</span>
      </PopoverTrigger>
      {/* A row click navigates, and portals still bubble React events to the row. */}
      <PopoverPopup
        side="right"
        align="start"
        width="sm"
        padding="compact"
        onClick={stopRowActivation}
        onDoubleClick={stopRowActivation}
      >
        <div className="flex min-w-0 flex-col gap-2">
          <RowAnswerContent thread={props.thread} onOpenThread={props.onOpenThread} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
