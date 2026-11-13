import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { PendingXAiPromptCompletion } from "./xaiAcpExtensionPart2.ts";
import type { GrokPlanPathHost, XAiAskUserQuestionRequestParams } from "./xaiAcpExtensionPart3.ts";
import { XAiPromptCompleteNotification, completedXAiPromptIdLimit, decodeXAiSessionUpdateNotification, nonEmptyString, xAiPromptCompleteFromSessionUpdate, xAiRateLimitedErrorCode, xAiSessionNotificationMethods } from "./xaiAcpExtensionPart2.ts";
import { CANONICAL_HOME_GROK_SESSION_PATH, CASE_INSENSITIVE_CANONICAL_HOME_GROK_SESSION_PATH, XAiAskUserQuestionRequest, grokPlanSessionPrefixes, pathHasTraversalSegment } from "./xaiAcpExtensionPart3.ts";
export type {
  XAiAcpBackgroundToolMutation,
  XAiAcpSubagentEndNotice,
  XAiAcpSubagentUpdate,
  XAiBackgroundTaskLifecycleMutation,
  XAiSubagentFinishedNotice,
} from "./xaiAcpExtensionPart2.ts";
export type {
  GrokPlanPathHost,
  XAiExitPlanModeOutcome,
  XAiExitPlanModeResponse,
} from "./xaiAcpExtensionPart3.ts";
export {
  extractXAiBackgroundTaskCompletion,
  extractXAiKilledBackgroundTasks,
  extractXAiMonitorTaskId,
  isXAiMonitorTool,
  isXAiPersistentMonitor,
  isXAiTaskCompletedWakeNotification,
  registerXAiBackgroundTaskTracking,
  registerXAiSubagentFinished,
  xAiBackgroundShellTaskId,
  xAiBackgroundTaskLifecycleMutation,
  xAiPromptCompleteFromSessionUpdate,
  xAiRateLimitedErrorCode,
  xAiSubagentFinishedNotice,
} from "./xaiAcpExtensionPart2.ts";
export {
  XAI_EMPTY_PLAN_MARKDOWN,
  XAiAskUserQuestionRequest,
  XAiExitPlanModeRequest,
  extractXAiAcpBackgroundToolMutation,
  extractXAiAcpSubagentEndNotice,
  extractXAiAcpSubagentUpdate,
  extractXAiExitPlanMarkdown,
  makeXAiExitPlanModeCapturedResponse,
  normalizeXAiAcpToolCallState,
} from "./xaiAcpExtensionPart3.ts";

export function isGrokPlanMarkdownPath(
  path: string | undefined | null,
  host: GrokPlanPathHost,
): boolean {
  if (typeof path !== "string") {
    return false;
  }
  const normalized = path.trim().replace(/\\/g, "/");
  const win32 = host.platform === "win32";
  const haystack = win32 ? normalized.toLowerCase() : normalized;
  if (
    normalized.length === 0 ||
    !haystack.endsWith("/plan.md") ||
    pathHasTraversalSegment(normalized)
  ) {
    return false;
  }
  for (const prefix of grokPlanSessionPrefixes(host)) {
    const needle = win32 ? prefix.toLowerCase() : prefix;
    if (!haystack.startsWith(needle)) {
      continue;
    }
    const rest = haystack.slice(needle.length);
    if (rest !== "plan.md" && rest.endsWith("plan.md")) {
      return true;
    }
  }
  return (
    win32 ? CASE_INSENSITIVE_CANONICAL_HOME_GROK_SESSION_PATH : CANONICAL_HOME_GROK_SESSION_PATH
  ).test(haystack);
}

export function extractGrokPlanMarkdownFromToolCallData(
  data: Record<string, unknown> | undefined,
  host: GrokPlanPathHost,
): string | undefined {
  if (!data) {
    return undefined;
  }

  let sawPlanWrite = false;
  const takePlanText = (
    value: string | undefined,
    filePath: string | undefined,
  ): string | undefined => {
    if (!isGrokPlanMarkdownPath(filePath, host) || value === undefined) {
      return undefined;
    }
    sawPlanWrite = true;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const rawInput = data.rawInput;
  if (isRecord(rawInput)) {
    const filePath =
      (typeof rawInput.file_path === "string" ? rawInput.file_path : undefined) ??
      (typeof rawInput.path === "string" ? rawInput.path : undefined);
    const content = typeof rawInput.content === "string" ? rawInput.content : undefined;
    const fromRaw = takePlanText(content, filePath);
    if (fromRaw !== undefined) {
      return fromRaw;
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
      const fromDiff = takePlanText(newText, path);
      if (fromDiff !== undefined) {
        return fromDiff;
      }
    }
  }

  return sawPlanWrite ? "" : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function trimmed(value: string | undefined): string | undefined {
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

export function extractXAiAskUserQuestionIdentity(params: XAiAskUserQuestionRequest): {
  readonly sessionId: string;
  readonly toolCallId: string;
} {
  const unwrapped = unwrapAskUserQuestionParams(params);
  return {
    sessionId: unwrapped.sessionId,
    toolCallId: unwrapped.toolCallId,
  };
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

function promptIdFromResponse(response: EffectAcpSchema.PromptResponse): string | undefined {
  const meta = response._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
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

function promptResponseFromXAi(
  notification: XAiPromptCompleteNotification,
): EffectAcpSchema.PromptResponse {
  const stopReason = normalizeXAiStopReason(notification.stopReason);
  const meta: Record<string, Schema.Json> = {
    sessionId: notification.sessionId,
  };
  if (notification.promptId !== undefined) {
    meta.promptId = notification.promptId;
    meta.requestId = notification.promptId;
  }
  if (notification.agentResult !== undefined) {
    meta.agentResult = notification.agentResult as Schema.Json;
  }
  return {
    stopReason,
    _meta: meta,
  };
}

// Grok completion can beat the prompt RPC error; carry its agentResult failure.
function xAiPromptFailure(
  notification: XAiPromptCompleteNotification,
): EffectAcpErrors.AcpRequestError | null {
  if (notification.stopReason === "rate_limit") {
    return new EffectAcpErrors.AcpRequestError({
      code: xAiRateLimitedErrorCode,
      errorMessage: "Grok usage limit reached. Try again later.",
    });
  }
  if (notification.stopReason === "error") {
    const agentResult = nonEmptyString(notification.agentResult);
    return new EffectAcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "Grok ended the turn with an error.",
      operation: "receive-response",
      ...(agentResult === undefined ? {} : { cause: new XAiPromptFailureText(agentResult) }),
    });
  }
  return null;
}

/** Keep unbounded provider text out of structured attributes; read only at presentation. */
export class XAiPromptFailureText extends Error {}

const registerXAiPromptCompletionFallback = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  sessionId: string,
  promptId: string,
) =>
  Deferred.make<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpRequestError>().pipe(
    Effect.tap((deferred) =>
      Ref.update(pendingRef, (pending) => [...pending, { sessionId, promptId, deferred }]),
    ),
    Effect.map((deferred) => ({ deferred, promptId })),
  );

const unregisterXAiPromptCompletionFallback = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpRequestError>,
) => Ref.update(pendingRef, (pending) => pending.filter((entry) => entry.deferred !== deferred));

const abortPendingPromptCompletions = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  sessionId?: string,
) =>
  Ref.modify(pendingRef, (pending) => {
    const [toAbort, remaining] = pending.reduce<
      [ReadonlyArray<PendingXAiPromptCompletion>, ReadonlyArray<PendingXAiPromptCompletion>]
    >(
      ([aborting, kept], entry) =>
        sessionId === undefined || entry.sessionId === sessionId
          ? [[...aborting, entry], kept]
          : [aborting, [...kept, entry]],
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
            : (() => {
                const sessionPendingIndexes = pending.flatMap((entry, entryIndex) =>
                  entry.sessionId === notification.sessionId ? [entryIndex] : [],
                );
                if (sessionPendingIndexes.length !== 1) {
                  return -1;
                }
                return sessionPendingIndexes[0] ?? -1;
              })();
        if (index < 0) {
          return [Effect.void, pending] as const;
        }
        const entry = pending[index];
        if (!entry) {
          return [Effect.void, pending] as const;
        }
        const failure = xAiPromptFailure(notification);
        const settle =
          failure !== null
            ? Deferred.fail(entry.deferred, failure).pipe(Effect.asVoid)
            : Deferred.succeed(entry.deferred, promptResponseFromXAi(notification)).pipe(
                Effect.asVoid,
              );
        return [settle, [...pending.slice(0, index), ...pending.slice(index + 1)]] as const;
      }).pipe(Effect.flatten);
    }),
  );

const rememberCompletedXAiPromptId = (
  completedPromptIdsRef: Ref.Ref<ReadonlyArray<string>>,
  response: EffectAcpSchema.PromptResponse,
  fallbackPromptId: string,
) => {
  const promptId = promptIdFromResponse(response) ?? fallbackPromptId;
  if (promptId.length === 0) {
    return Effect.void;
  }
  return Ref.update(completedPromptIdsRef, (completedPromptIds) => {
    if (completedPromptIds.includes(promptId)) {
      return completedPromptIds;
    }
    return [...completedPromptIds, promptId].slice(-completedXAiPromptIdLimit);
  });
};

export const makeXAiPromptCompletionRuntime = Effect.fn("makeXAiPromptCompletionRuntime")(
  function* (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) {
    // Grok multiplexes session updates on extension methods that permit only one handler.
    const sessionNotificationHandlers = new Map<
      string,
      (params: unknown) => Effect.Effect<void, EffectAcpErrors.AcpError>
    >();
    let nextPromptFallbackId = 0;
    const allocatePromptFallbackId = Effect.sync(() => {
      nextPromptFallbackId += 1;
      return `t3-xai-prompt-${nextPromptFallbackId}`;
    });
    const pendingXAiPromptCompletionsRef = yield* Ref.make<
      ReadonlyArray<PendingXAiPromptCompletion>
    >([]);
    const completedXAiPromptIdsRef = yield* Ref.make<ReadonlyArray<string>>([]);

    const settleFromPromptComplete = (notification: XAiPromptCompleteNotification) =>
      resolveXAiPromptCompletionFallback({
        pendingRef: pendingXAiPromptCompletionsRef,
        completedPromptIdsRef: completedXAiPromptIdsRef,
        notification,
      }).pipe(Effect.ignore);

    yield* Effect.forEach(
      ["x.ai/session/prompt_complete", "_x.ai/session/prompt_complete"] as const,
      (method) =>
        runtime.handleExtNotification(
          method,
          XAiPromptCompleteNotification,
          settleFromPromptComplete,
        ),
      { discard: true },
    );

    yield* Effect.forEach(
      xAiSessionNotificationMethods,
      (method) =>
        runtime.handleExtNotification(method, Schema.Unknown, (params) =>
          decodeXAiSessionUpdateNotification(params).pipe(
            Effect.flatMap((notification) => {
              const complete = xAiPromptCompleteFromSessionUpdate(notification);
              return complete === null ? Effect.void : settleFromPromptComplete(complete);
            }),
            Effect.ignore,
            Effect.andThen(
              Effect.suspend(
                () => sessionNotificationHandlers.get(method)?.(params) ?? Effect.void,
              ),
            ),
          ),
        ),
      { discard: true },
    );

    return {
      ...runtime,
      handleExtNotification: (method, payload, handler) =>
        xAiSessionNotificationMethods.some((owned) => owned === method)
          ? Effect.sync(() => {
              sessionNotificationHandlers.set(method, (params) =>
                Schema.decodeUnknownEffect(payload)(params).pipe(
                  Effect.mapError((error) =>
                    EffectAcpErrors.AcpProtocolParseError.fromSchemaError(
                      "decode-notification-payload",
                      method,
                      error,
                    ),
                  ),
                  Effect.flatMap(handler),
                ),
              );
            })
          : runtime.handleExtNotification(method, payload, handler),
      prompt: Effect.fn("xaiAcpExtension.prompt")(function* (payload, promptOptions?) {
        const started = yield* runtime.start();
        const promptId = yield* allocatePromptFallbackId;
        const fallback = yield* registerXAiPromptCompletionFallback(
          pendingXAiPromptCompletionsRef,
          started.sessionId,
          promptId,
        );
        const cancelledResponse = promptResponseFromXAi({
          sessionId: started.sessionId,
          promptId: fallback.promptId,
          stopReason: "cancelled",
          agentResult: null,
        });
        const promptRpcFiber = yield* runtime
          .prompt(
            {
              ...payload,
              _meta: {
                ...payload._meta,
                promptId: fallback.promptId,
                requestId: fallback.promptId,
              },
            },
            promptOptions,
          )
          .pipe(Effect.forkChild);
        return yield* Effect.raceFirst(
          Fiber.join(promptRpcFiber).pipe(
            Effect.catchCauseIf(
              (cause) => Cause.hasInterruptsOnly(cause),
              (_cause) => Effect.succeed(cancelledResponse),
            ),
          ),
          Deferred.await(fallback.deferred),
        ).pipe(
          Effect.tap((response) =>
            rememberCompletedXAiPromptId(completedXAiPromptIdsRef, response, fallback.promptId),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Fiber.interrupt(promptRpcFiber).pipe(Effect.ignore);
              yield* unregisterXAiPromptCompletionFallback(
                pendingXAiPromptCompletionsRef,
                fallback.deferred,
              );
            }),
          ),
        );
      }),
      cancel: Effect.gen(function* () {
        // Cancellation must bypass start so it can reach a stalled runtime.
        yield* abortPendingPromptCompletions(pendingXAiPromptCompletionsRef);
        yield* runtime.cancel;
      }),
    } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
  },
);
