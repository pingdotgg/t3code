import { EnvironmentId, type ProviderUserInputAnswers } from "@t3tools/contracts";
import { useState } from "react";

import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import { derivePendingUserInputProgress } from "../../../pendingUserInput";
import { proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import { proposedPlanStepCount } from "../../../proposedPlan";
import { ComposerPendingUserInputPanel } from "../../chat/ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "../../chat/ComposerPlanFollowUpBanner";
import { ComposerSurface } from "../../chat/ComposerSurface";
import { Text } from "../../ui/text";
import { PLAYBACK_THREAD_ID, type playbackComposerRequests } from "./playback";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { SCENE_WORKSPACE } from "./turnScripts";

type PlaybackRequests = ReturnType<typeof playbackComposerRequests>;

/**
 * The composer's request slot over the player's state: the real question and
 * plan rows, fed what ChatComposer would feed them. Answering one
 * reports the decision or answers back, and the player records it as the
 * orchestrator does, so the row leaves and the timeline settles.
 */
export function PlaybackComposer({
  requests,
  providerLabel,
  onAnswer,
  onBuildPlan,
}: {
  requests: PlaybackRequests;
  /** The header's provider name, as ChatComposer passes it. */
  providerLabel: string;
  onAnswer: (requestId: string, answers: ProviderUserInputAnswers) => void;
  onBuildPlan: () => void;
}) {
  const question = requests.userInputs[0] ?? null;
  // Draft answers and the question cursor live per request, as in ChatView.
  const [drafts, setDrafts] = useState<Record<string, Record<string, PendingUserInputDraftAnswer>>>(
    {},
  );
  const [questionIndexes, setQuestionIndexes] = useState<Record<string, number>>({});

  // The same cards ChatComposer portals into the request host above the tray.
  const card = question ? (
    <QuestionCard
      key={question.requestId}
      question={question}
      providerLabel={providerLabel}
      answers={drafts[question.requestId] ?? {}}
      questionIndex={questionIndexes[question.requestId] ?? 0}
      onAnswersChange={(answers) =>
        setDrafts((existing) => ({ ...existing, [question.requestId]: answers }))
      }
      onQuestionIndexChange={(index) =>
        setQuestionIndexes((existing) => ({ ...existing, [question.requestId]: index }))
      }
      onSubmit={(answers) => onAnswer(question.requestId, answers)}
    />
  ) : requests.proposedPlan ? (
    <ComposerPlanFollowUpBanner
      key={requests.proposedPlan.id}
      planTitle={proposedPlanTitle(requests.proposedPlan.planMarkdown) ?? null}
      stepCount={proposedPlanStepCount(requests.proposedPlan.planMarkdown)}
      disabled={false}
      isSending={false}
      onBuild={onBuildPlan}
      onBuildInNewThread={onBuildPlan}
      onRevise={() => undefined}
    />
  ) : null;

  return (
    <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col px-4 pb-4">
      {card ? (
        <div data-chat-composer-request-host="true" className="mb-2">
          {card}
        </div>
      ) : null}
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className="flex min-h-12 items-center gap-2 px-4 py-2">
              <Text variant="prompt" tone="dim" truncate>
                {question ? "Write your own answer" : "The composer's request slot"}
              </Text>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}

function QuestionCard({
  question,
  providerLabel,
  answers,
  questionIndex,
  onAnswersChange,
  onQuestionIndexChange,
  onSubmit,
}: {
  question: PlaybackRequests["userInputs"][number];
  providerLabel: string | null;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onAnswersChange: (answers: Record<string, PendingUserInputDraftAnswer>) => void;
  onQuestionIndexChange: (index: number) => void;
  onSubmit: (answers: ProviderUserInputAnswers) => void;
}) {
  const progress = derivePendingUserInputProgress(question.questions, answers, questionIndex);
  const resolved = buildPendingUserInputAnswers(question.questions, answers);
  const advance = () => {
    if (!progress.isLastQuestion) {
      onQuestionIndexChange(progress.questionIndex + 1);
      return;
    }
    if (resolved) onSubmit(resolved);
  };
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[question]}
      cwd={SCENE_WORKSPACE.cwd}
      threadRef={scopeThreadRef(EnvironmentId.make("playback-environment"), PLAYBACK_THREAD_ID)}
      respondingRequestIds={[]}
      answers={answers}
      questionIndex={progress.questionIndex}
      providerLabel={providerLabel}
      primaryAction={{
        questionIndex: progress.questionIndex,
        isLastQuestion: progress.isLastQuestion,
        canAdvance: progress.canAdvance,
        isResponding: false,
        isComplete: resolved !== null,
      }}
      onToggleOption={(questionId, optionValue) => {
        const entry = question.questions.find((candidate) => candidate.id === questionId);
        if (!entry) return;
        onAnswersChange({
          ...answers,
          [questionId]: togglePendingUserInputOptionSelection(
            entry,
            answers[questionId],
            optionValue,
          ),
        });
      }}
      onAdvance={advance}
      onSubmit={advance}
      onPrevious={() => onQuestionIndexChange(Math.max(0, progress.questionIndex - 1))}
      onDismiss={() => {}}
    />
  );
}
