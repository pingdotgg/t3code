import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  type BotWorkerRequest,
  seedUserInputDraftAnswers,
  userInputDraftKey,
} from "@t3tools/client-runtime/state/thread-requests";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { derivePendingUserInputProgress } from "~/pendingUserInput";
import {
  usePendingUserInputAnswers,
  usePendingUserInputQuestionIndex,
} from "~/questionAttachments";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { OtherThreadApproval } from "../chat/ChildThreadApprovals";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const NO_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};

function WorkerLink({ thread, title }: { thread: ScopedThreadRef; title: string }) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(thread)}
      className="min-w-0 truncate font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {title}
    </Link>
  );
}

function WorkerQuestion({
  request,
}: {
  request: Extract<BotWorkerRequest, { kind: "user-input" }>;
}) {
  const title = request.title;
  const gt = useGT();
  const { thread, userInput } = request;
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: false });
  // The worker's own page keys its drafts the same way, so an answer started in either place carries over.
  const draftKey = userInputDraftKey(thread.environmentId, thread.threadId, userInput.requestId);
  const storedAnswers = usePendingUserInputAnswers((state) => state[draftKey] ?? NO_ANSWERS);
  const questionIndex = usePendingUserInputQuestionIndex((state) => state[draftKey] ?? 0);
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answers = seedUserInputDraftAnswers(userInput.questions, storedAnswers);
  const progress = derivePendingUserInputProgress(userInput.questions, answers, questionIndex);
  const question = progress.activeQuestion;
  const connected = Option.isSome(usePreparedConnection(thread.environmentId));
  const disabled =
    !canOperate || !connected || responding || userInput.responseCapability === "not_resumable";
  const notice = !connected ? gt("Not connected") : error;

  const readProgress = () =>
    derivePendingUserInputProgress(
      userInput.questions,
      seedUserInputDraftAnswers(
        userInput.questions,
        usePendingUserInputAnswers.getState()[draftKey] ?? NO_ANSWERS,
      ),
      usePendingUserInputQuestionIndex.getState()[draftKey] ?? 0,
    );
  const updateAnswer = (
    questionId: string,
    update: (
      question: (typeof userInput.questions)[number],
      draft: PendingUserInputDraftAnswer | undefined,
    ) => PendingUserInputDraftAnswer,
  ) => {
    const target = userInput.questions.find((entry) => entry.id === questionId);
    if (!target) return;
    usePendingUserInputAnswers.setState((existing) => ({
      ...existing,
      [draftKey]: {
        ...existing[draftKey],
        [questionId]: update(target, existing[draftKey]?.[questionId]),
      },
    }));
  };
  const submit = async () => {
    const resolved = buildPendingUserInputAnswers(
      userInput.questions,
      seedUserInputDraftAnswers(
        userInput.questions,
        usePendingUserInputAnswers.getState()[draftKey] ?? NO_ANSWERS,
      ),
    );
    if (resolved === null || disabled) return;
    setResponding(true);
    setError(null);
    const result = await respond({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId, requestId: userInput.requestId, answers: resolved },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Failed to submit user input."));
    }
    setResponding(false);
  };
  const advance = () => {
    const current = readProgress();
    if (current.isLastQuestion) {
      void submit();
      return;
    }
    if (!current.canAdvance) return;
    usePendingUserInputQuestionIndex.setState((existing) => ({
      ...existing,
      [draftKey]: current.questionIndex + 1,
    }));
  };
  const onDismiss = async () => {
    setResponding(true);
    setError(null);
    const result = await dismiss({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId, requestId: userInput.requestId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(gt("Failed to dismiss the question."));
    }
    setResponding(false);
  };

  return (
    <>
      {/* Several cards share the page with the Bot's composer, so number keys stay with the Bot's own question. */}
      <BackgroundThreadContext value>
        <ComposerPendingUserInputPanel
          pendingUserInputs={[userInput]}
          cwd={undefined}
          threadRef={thread}
          disabled={disabled}
          respondingRequestIds={responding ? [userInput.requestId] : []}
          answers={answers}
          questionIndex={questionIndex}
          onToggleOption={(questionId, optionValue) =>
            updateAnswer(questionId, (target, draft) =>
              togglePendingUserInputOptionSelection(target, draft, optionValue),
            )
          }
          onAdvance={advance}
          onDismiss={() => void onDismiss()}
          label={
            <span className="max-w-1/3 min-w-0 truncate font-medium text-foreground">{title}</span>
          }
          footer={
            <form
              className="flex items-center gap-2 px-3 pb-3 pt-1"
              onSubmit={(event) => {
                event.preventDefault();
                advance();
              }}
            >
              {question !== null && question.allowCustomAnswer !== false ? (
                <Input
                  size="compact"
                  className="min-w-0 flex-1"
                  aria-label={gt("Your answer")}
                  placeholder={gt("Type your own answer")}
                  value={progress.customAnswer}
                  disabled={disabled}
                  onChange={(event) =>
                    updateAnswer(question.id, (target, draft) =>
                      setPendingUserInputCustomAnswer(target, draft, event.currentTarget.value),
                    )
                  }
                />
              ) : (
                <span className="flex-1" />
              )}
              {notice !== null ? (
                <p role="alert" className="min-w-0 truncate text-destructive">
                  {notice}
                </p>
              ) : null}
              <Button type="submit" size="xs" disabled={disabled || !progress.canAdvance}>
                {progress.isLastQuestion ? <T>Send answer</T> : <T>Next</T>}
              </Button>
            </form>
          }
        />
      </BackgroundThreadContext>
    </>
  );
}

function WorkerRequestCard({ request }: { request: BotWorkerRequest }) {
  const gt = useGT();
  return (
    <section
      aria-label={gt("Request from {title}", { title: request.title })}
      className="rounded-lg border border-border bg-background text-xs"
    >
      {request.kind === "approval" ? (
        <p className="flex min-w-0 items-center gap-1 px-3 pt-2.5 pb-1 text-muted-foreground">
          <T>
            <Var>
              <WorkerLink thread={request.thread} title={request.title} />
            </Var>{" "}
            needs your approval
          </T>
        </p>
      ) : null}
      {request.kind === "approval" ? (
        <div className="px-3 pb-3 pt-1">
          <OtherThreadApproval thread={request.thread} approval={request.approval} />
        </div>
      ) : (
        <WorkerQuestion request={request} />
      )}
    </section>
  );
}

/** What the Bot's workers wait on, answered on each worker's own request. */
export function BotWorkerRequests({ requests }: { requests: ReadonlyArray<BotWorkerRequest> }) {
  if (requests.length === 0) return null;
  return (
    <div className="chat-content-lane flex flex-col gap-2 pb-2">
      {requests.map((request) => (
        <WorkerRequestCard
          key={JSON.stringify([
            request.thread.environmentId,
            request.thread.threadId,
            request.kind === "approval" ? request.approval.requestId : request.userInput.requestId,
          ])}
          request={request}
        />
      ))}
    </div>
  );
}
