import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const XAiPromptCompleteNotification = Schema.Struct({
  sessionId: Schema.String,
  promptId: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  agentResult: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

type XAiPromptCompleteNotification = typeof XAiPromptCompleteNotification.Type;

interface PendingXAiPromptCompletion {
  readonly sessionId: string;
  readonly promptId: string;
  readonly deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse>;
}

const completedXAiPromptIdLimit = 128;
const xAiStopReasonMissingMetaKey = "xAiStopReasonMissing";

const XAiAskUserQuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});

const XAiAskUserQuestion = Schema.Struct({
  id: Schema.optional(Schema.String),
  question: Schema.String,
  options: Schema.Array(XAiAskUserQuestionOption),
  multiSelect: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const XAiAskUserQuestionParams = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  questions: Schema.Array(XAiAskUserQuestion),
  mode: Schema.Literals(["default", "plan"]),
});

const XAiWrappedAskUserQuestionParams = Schema.Struct({
  method: Schema.Literals(["x.ai/ask_user_question", "_x.ai/ask_user_question"]),
  params: XAiAskUserQuestionParams,
});

export const XAiAskUserQuestionRequest = Schema.Union([
  XAiAskUserQuestionParams,
  XAiWrappedAskUserQuestionParams,
]);

type XAiAskUserQuestionRequestParams = typeof XAiAskUserQuestionParams.Type;
type XAiAskUserQuestionRequest = typeof XAiAskUserQuestionRequest.Type;

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function unwrapAskUserQuestionParams(
  params: XAiAskUserQuestionRequest,
): XAiAskUserQuestionRequestParams {
  return "params" in params ? params.params : params;
}

export function extractXAiAskUserQuestions(
  params: XAiAskUserQuestionRequest,
): ReadonlyArray<UserInputQuestion> {
  return unwrapAskUserQuestionParams(params).questions.map((question) => ({
    id: question.id ?? question.question,
    header: "Question",
    question: question.question,
    multiSelect: question.multiSelect === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

interface XAiAskUserQuestionAnnotation {
  readonly preview?: string;
  readonly notes?: string;
}

interface XAiAskUserQuestionAcceptedResponse {
  readonly outcome: "accepted";
  readonly answers: Record<string, ReadonlyArray<string>>;
  readonly annotations?: Record<string, XAiAskUserQuestionAnnotation>;
}

interface XAiAskUserQuestionCancelledResponse {
  readonly outcome: "cancelled";
}

export type XAiAskUserQuestionResponse =
  | XAiAskUserQuestionAcceptedResponse
  | XAiAskUserQuestionCancelledResponse;

interface NormalizedXAiAnswer {
  readonly questionText: string;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly annotation?: XAiAskUserQuestionAnnotation;
}

function answerValues(answer: unknown): ReadonlyArray<string> {
  if (Array.isArray(answer)) {
    return answer.flatMap((entry) => {
      const text = typeof entry === "string" ? trimmed(entry) : undefined;
      return text ? [text] : [];
    });
  }
  const text = typeof answer === "string" ? trimmed(answer) : undefined;
  return text ? [text] : [];
}

function normalizeAnswerForXAi(
  question: XAiAskUserQuestionRequestParams["questions"][number],
  answer: unknown,
): NormalizedXAiAnswer | undefined {
  const values = answerValues(answer);
  if (values.length === 0) {
    return undefined;
  }

  const optionByLabel = new Map(question.options.map((option) => [option.label, option]));
  const resolvedValues = values.map((value) => ({
    value,
    option: optionByLabel.get(value),
  }));
  const selectedLabels = resolvedValues.flatMap(({ option }) => (option ? [option.label] : []));
  const notes = resolvedValues.flatMap(({ option, value }) => (option ? [] : [value]));
  const preview =
    question.multiSelect === true
      ? undefined
      : resolvedValues.map(({ option }) => trimmed(option?.preview)).find((value) => value);

  const annotation =
    preview || notes.length > 0
      ? {
          ...(preview ? { preview } : {}),
          ...(notes.length > 0 ? { notes: notes.join("\n") } : {}),
        }
      : undefined;

  return {
    questionText: question.question,
    selectedLabels: selectedLabels.length > 0 ? selectedLabels : ["Other"],
    ...(annotation ? { annotation } : {}),
  };
}

function findQuestionAnswer(
  answers: ProviderUserInputAnswers,
  question: XAiAskUserQuestionRequestParams["questions"][number],
): unknown {
  const key = question.id ?? question.question;
  return answers[key] ?? answers[question.question];
}

export function makeXAiAskUserQuestionResponse(
  params: XAiAskUserQuestionRequest,
  answers: ProviderUserInputAnswers,
): XAiAskUserQuestionAcceptedResponse {
  const questions = unwrapAskUserQuestionParams(params).questions;
  const normalized = questions.flatMap((question) => {
    const entry = normalizeAnswerForXAi(question, findQuestionAnswer(answers, question));
    return entry ? [entry] : [];
  });
  const annotations = Object.fromEntries(
    normalized.flatMap((entry) =>
      entry.annotation ? [[entry.questionText, entry.annotation] as const] : [],
    ),
  );

  return {
    outcome: "accepted",
    answers: Object.fromEntries(
      normalized.map((entry) => [entry.questionText, entry.selectedLabels]),
    ),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

export function makeXAiAskUserQuestionCancelledResponse(): XAiAskUserQuestionCancelledResponse {
  return { outcome: "cancelled" };
}

const XAiExitPlanModeParams = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  planContent: Schema.optional(Schema.NullOr(Schema.String)),
});

const XAiWrappedExitPlanModeParams = Schema.Struct({
  method: Schema.Literals(["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"]),
  params: XAiExitPlanModeParams,
});

export const XAiExitPlanModeRequest = Schema.Union([
  XAiExitPlanModeParams,
  XAiWrappedExitPlanModeParams,
]);

export type XAiExitPlanModeRequest = typeof XAiExitPlanModeRequest.Type;
export type XAiExitPlanModeParams = typeof XAiExitPlanModeParams.Type;

export function unwrapExitPlanModeParams(params: XAiExitPlanModeRequest): XAiExitPlanModeParams {
  return "method" in params ? params.params : params;
}

export function makeXAiExitPlanModeApprovedResponse(): { readonly outcome: "approved" } {
  return { outcome: "approved" };
}

export function makeXAiExitPlanModeReviseResponse(feedback: string): {
  readonly outcome: "rejected";
  readonly feedback: string;
} {
  const feedbackText = feedback.trim();
  return {
    outcome: "rejected",
    feedback: feedbackText.length > 0 ? feedbackText : "Please revise the plan.",
  };
}

export const XAI_EMPTY_PLAN_MARKDOWN =
  "# No plan written yet\n\n(The agent exited plan mode without writing a plan.)";

export function extractXAiExitPlanMarkdown(
  params: XAiExitPlanModeRequest,
  fallback?: string | null,
): string {
  const content = unwrapExitPlanModeParams(params).planContent;
  const fromRequest = typeof content === "string" ? trimmed(content) : undefined;
  if (fromRequest) {
    return fromRequest;
  }
  const fromFallback = fallback?.trim();
  if (fromFallback && fromFallback.length > 0) {
    return fromFallback;
  }
  return XAI_EMPTY_PLAN_MARKDOWN;
}

export type XAiExitPlanModeOutcome = "approved" | "abandoned" | "request_changes" | "rejected";

export interface XAiExitPlanModeResponse {
  readonly outcome: XAiExitPlanModeOutcome;
  readonly feedback?: string;
}

/**
 * Client captured the plan for T3's proposed-plan card. Abandon the native
 * Grok plan-approval gate so the turn unblocks; the user implements via T3 UI.
 */
export function makeXAiExitPlanModeCapturedResponse(feedback?: string): XAiExitPlanModeResponse {
  return {
    outcome: "abandoned",
    feedback:
      feedback ??
      "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
  };
}

/**
 * True when a path is Grok's session plan file under
 * `~/.grok/sessions/<encoded-cwd>/<session-id>/plan.md`.
 * Requires exactly two path segments after `.grok/sessions/` so workspace
 * files like `/repo/.grok/sessions/demo/plan.md` (too shallow) or
 * `/repo/.grok/sessions/foo/bar/baz/plan.md` (too deep) are rejected.
 */
export function isGrokPlanMarkdownPath(path: string | undefined | null): boolean {
  if (typeof path !== "string") {
    return false;
  }
  const normalized = path.trim().replace(/\\/g, "/");
  if (normalized.length === 0) {
    return false;
  }
  // Real layout: ~/.grok/sessions/<encoded-cwd>/<session-id>/plan.md
  return /(?:^|\/)\.grok\/sessions\/[^/]+\/[^/]+\/plan\.md$/i.test(normalized);
}

/**
 * Extract plan markdown from a Grok write/edit tool call targeting plan.md.
 * Used so T3 can show the plan while plan mode is still active (before exit).
 */
export function extractGrokPlanMarkdownFromToolCallData(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) {
    return undefined;
  }

  const rawInput = data.rawInput;
  if (isRecord(rawInput)) {
    const filePath =
      (typeof rawInput.file_path === "string" ? rawInput.file_path : undefined) ??
      (typeof rawInput.path === "string" ? rawInput.path : undefined);
    const content = typeof rawInput.content === "string" ? rawInput.content : undefined;
    if (isGrokPlanMarkdownPath(filePath) && content && content.trim().length > 0) {
      return content.trim();
    }
  }

  const content = data.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block) || block.type !== "diff") {
        continue;
      }
      const path = typeof block.path === "string" ? block.path : undefined;
      const newText = typeof block.newText === "string" ? block.newText : undefined;
      if (isGrokPlanMarkdownPath(path) && newText && newText.trim().length > 0) {
        return newText.trim();
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Manual `/compact` and auto-compact complete as `auto_compact_completed`.
 */
const XAiSessionNotificationUpdate = Schema.Struct({
  sessionUpdate: Schema.String,
  tokens_before: Schema.optional(Schema.Number),
  tokens_after: Schema.optional(Schema.Number),
  summary_preview: Schema.optional(Schema.NullOr(Schema.String)),
});

export const XAiSessionNotification = Schema.Struct({
  sessionId: Schema.String,
  update: XAiSessionNotificationUpdate,
  _meta: Schema.optional(Schema.Unknown),
});

export type XAiSessionNotification = typeof XAiSessionNotification.Type;

export interface XAiAutoCompactCompleted {
  readonly sessionId: string;
  readonly tokensBefore: number | undefined;
  readonly tokensAfter: number | undefined;
  readonly summaryPreview: string | undefined;
  readonly raw: XAiSessionNotification;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Returns compact details when the notification is a completed compaction; otherwise null. */
export function extractXAiAutoCompactCompleted(
  notification: XAiSessionNotification,
): XAiAutoCompactCompleted | null {
  if (notification.update.sessionUpdate !== "auto_compact_completed") {
    return null;
  }
  const summaryPreview = trimmed(notification.update.summary_preview ?? undefined);
  return {
    sessionId: notification.sessionId,
    tokensBefore: finiteNonNegative(notification.update.tokens_before),
    tokensAfter: finiteNonNegative(notification.update.tokens_after),
    summaryPreview,
    raw: notification,
  };
}

/**
 * Adds Grok's private prompt-completion fallback around a standards-only ACP runtime.
 * The underlying runtime remains unaware of xAI methods and metadata.
 */
export const makeXAiPromptCompletionRuntime = Effect.fn("makeXAiPromptCompletionRuntime")(
  function* (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) {
    const activeSessionIdRef = yield* Ref.make<string | undefined>(undefined);
    const pendingRef = yield* Ref.make<ReadonlyArray<PendingXAiPromptCompletion>>([]);
    const completedPromptIdsRef = yield* Ref.make<ReadonlyArray<string>>([]);
    let nextPromptFallbackId = 0;
    const allocatePromptFallbackId = Effect.sync(() => {
      nextPromptFallbackId += 1;
      return `t3-xai-prompt-${nextPromptFallbackId}`;
    });

    yield* runtime.handleExtNotification(
      "_x.ai/session/prompt_complete",
      XAiPromptCompleteNotification,
      (notification) =>
        resolveXAiPromptCompletionFallback({
          pendingRef,
          completedPromptIdsRef,
          notification,
        }),
    );

    return {
      ...runtime,
      start: () =>
        runtime
          .start()
          .pipe(Effect.tap((started) => Ref.set(activeSessionIdRef, started.sessionId))),
      prompt: (payload) =>
        Effect.gen(function* () {
          const sessionId = yield* Ref.get(activeSessionIdRef);
          if (sessionId === undefined) {
            return yield* runtime.prompt(payload);
          }

          const promptId = yield* allocatePromptFallbackId;
          const fallback = yield* registerXAiPromptCompletionFallback(
            pendingRef,
            sessionId,
            promptId,
          );
          const requestPayload = {
            ...payload,
            _meta: {
              ...payload._meta,
              promptId: fallback.promptId,
              requestId: fallback.promptId,
            },
          } satisfies Omit<EffectAcpSchema.PromptRequest, "sessionId">;

          return yield* Effect.raceFirst(
            runtime.prompt(requestPayload),
            Deferred.await(fallback.deferred),
          ).pipe(
            Effect.tap((response) =>
              rememberCompletedXAiPromptId(completedPromptIdsRef, response, fallback.promptId),
            ),
            Effect.ensuring(unregisterXAiPromptCompletionFallback(pendingRef, fallback.deferred)),
          );
        }),
      cancel: Ref.get(activeSessionIdRef).pipe(
        Effect.flatMap((sessionId) =>
          sessionId === undefined
            ? runtime.cancel
            : abortPendingPromptCompletions(pendingRef, sessionId).pipe(
                Effect.andThen(runtime.cancel),
              ),
        ),
      ),
    } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
  },
);

const registerXAiPromptCompletionFallback = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  sessionId: string,
  promptId: string,
) =>
  Deferred.make<EffectAcpSchema.PromptResponse>().pipe(
    Effect.tap((deferred) =>
      Ref.update(pendingRef, (pending) => [...pending, { sessionId, promptId, deferred }]),
    ),
    Effect.map((deferred) => ({ deferred, promptId })),
  );

const unregisterXAiPromptCompletionFallback = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse>,
) => Ref.update(pendingRef, (pending) => pending.filter((entry) => entry.deferred !== deferred));

const abortPendingPromptCompletions = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  sessionId: string,
) =>
  Ref.modify(pendingRef, (pending) => {
    const [toAbort, remaining] = pending.reduce<
      [ReadonlyArray<PendingXAiPromptCompletion>, ReadonlyArray<PendingXAiPromptCompletion>]
    >(
      ([aborting, kept], entry) =>
        entry.sessionId === sessionId ? [[...aborting, entry], kept] : [aborting, [...kept, entry]],
      [[], []],
    );
    if (toAbort.length === 0) {
      return [Effect.void, pending] as const;
    }
    return [
      Effect.forEach(
        toAbort,
        (entry) =>
          Deferred.succeed(
            entry.deferred,
            promptResponseFromXAi({
              sessionId: entry.sessionId,
              promptId: entry.promptId,
              stopReason: "cancelled",
              agentResult: null,
            }),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
      remaining,
    ] as const;
  }).pipe(Effect.flatten);

const resolveXAiPromptCompletionFallback = ({
  pendingRef,
  completedPromptIdsRef,
  notification,
}: {
  readonly pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>;
  readonly completedPromptIdsRef: Ref.Ref<ReadonlyArray<string>>;
  readonly notification: XAiPromptCompleteNotification;
}) =>
  Ref.get(completedPromptIdsRef).pipe(
    Effect.flatMap((completedPromptIds) => {
      if (
        notification.promptId !== undefined &&
        completedPromptIds.includes(notification.promptId)
      ) {
        return Effect.void;
      }
      return Ref.modify(pendingRef, (pending) => {
        const index =
          notification.promptId !== undefined
            ? pending.findIndex(
                (entry) =>
                  entry.sessionId === notification.sessionId &&
                  entry.promptId === notification.promptId,
              )
            : pending.findIndex((entry) => entry.sessionId === notification.sessionId);
        if (index < 0) {
          return [Effect.void, pending] as const;
        }
        const entry = pending[index];
        if (!entry) {
          return [Effect.void, pending] as const;
        }
        return [
          Deferred.succeed(entry.deferred, promptResponseFromXAi(notification)).pipe(Effect.asVoid),
          [...pending.slice(0, index), ...pending.slice(index + 1)],
        ] as const;
      }).pipe(Effect.flatten);
    }),
  );

const rememberCompletedXAiPromptId = (
  completedPromptIdsRef: Ref.Ref<ReadonlyArray<string>>,
  response: EffectAcpSchema.PromptResponse,
  fallbackPromptId: string,
) => {
  const promptId = promptIdFromResponse(response) ?? fallbackPromptId;
  return Ref.update(completedPromptIdsRef, (completedPromptIds) => {
    if (completedPromptIds.includes(promptId)) {
      return completedPromptIds;
    }
    return [...completedPromptIds, promptId].slice(-completedXAiPromptIdLimit);
  });
};

function promptIdFromResponse(response: EffectAcpSchema.PromptResponse): string | undefined {
  const meta = response._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

export function promptResponseHasMissingXAiStopReason(
  response: EffectAcpSchema.PromptResponse,
): boolean {
  const meta = response._meta;
  return meta !== null && typeof meta === "object" && meta[xAiStopReasonMissingMetaKey] === true;
}

function promptResponseFromXAi(
  notification: XAiPromptCompleteNotification,
): EffectAcpSchema.PromptResponse {
  const stopReason = normalizeXAiStopReason(notification.stopReason);
  const meta: Record<string, unknown> = {
    sessionId: notification.sessionId,
  };
  if (notification.stopReason === undefined) {
    meta[xAiStopReasonMissingMetaKey] = true;
  }
  if (notification.promptId !== undefined) {
    meta.promptId = notification.promptId;
    meta.requestId = notification.promptId;
  }
  if (notification.agentResult !== undefined) {
    meta.agentResult = notification.agentResult;
  }
  return {
    stopReason,
    _meta: meta,
  };
}

function normalizeXAiStopReason(value: string | undefined): EffectAcpSchema.StopReason {
  switch (value) {
    case "cancelled":
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return value;
    default:
      return "end_turn";
  }
}
