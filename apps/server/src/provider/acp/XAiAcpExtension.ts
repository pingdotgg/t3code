import * as NodeOS from "node:os";

import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
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
  readonly deferred: Deferred.Deferred<
    EffectAcpSchema.PromptResponse,
    EffectAcpErrors.AcpRequestError
  >;
}

const completedXAiPromptIdLimit = 128;
const xAiStopReasonMissingMetaKey = "xAiStopReasonMissing";
const xAiRateLimitedErrorCode = -32003;

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

// ---------------------------------------------------------------------------
// x.ai/exit_plan_mode — plan approval gate (mirrors Grok Build TUI plan window)
// ---------------------------------------------------------------------------

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

type XAiExitPlanModeRequestParams = typeof XAiExitPlanModeParams.Type;
type XAiExitPlanModeRequest = typeof XAiExitPlanModeRequest.Type;

function unwrapExitPlanModeParams(params: XAiExitPlanModeRequest): XAiExitPlanModeRequestParams {
  return "params" in params ? params.params : params;
}

/** Empty-state copy when Grok exits plan mode without a plan file. */
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

export type XAiExitPlanModeOutcome = "approved" | "abandoned" | "request_changes";

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

function normalizeFsPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathHasTraversalSegment(normalized: string): boolean {
  return normalized.split("/").includes("..");
}

function addGrokSessionPrefix(
  prefixes: Set<string>,
  homeOrRoot: string,
  nestedGrokDir: boolean,
): void {
  const root = normalizeFsPath(homeOrRoot);
  if (!root) {
    return;
  }
  prefixes.add(nestedGrokDir ? `${root}/.grok/sessions/` : `${root}/sessions/`);
}

/** Injected host bits so these helpers stay off `process.platform` / `process.env`. */
export interface GrokPlanPathHost {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
}

function grokPlanSessionPrefixes(environment: NodeJS.ProcessEnv): ReadonlySet<string> {
  const prefixes = new Set<string>();
  addGrokSessionPrefix(prefixes, NodeOS.homedir(), true);
  addGrokSessionPrefix(prefixes, "~", true);
  addGrokSessionPrefix(prefixes, environment.HOME ?? "", true);
  addGrokSessionPrefix(prefixes, environment.USERPROFILE ?? "", true);
  // ACP mock and isolated Grok spawns use a HOME that is not the server process home.
  addGrokSessionPrefix(prefixes, "/tmp/mock-home", true);
  const grokHome = environment.GROK_HOME ?? "";
  addGrokSessionPrefix(prefixes, grokHome, false);
  addGrokSessionPrefix(prefixes, grokHome, true);
  return prefixes;
}

const CANONICAL_HOME_GROK_SESSION_PATH =
  /^(?:\/home\/[^/]+|\/Users\/[^/]+|[a-zA-Z]:\/Users\/[^/]+)\/\.grok\/sessions\/(?:[^/]+\/)+plan\.md$/;
const CASE_INSENSITIVE_CANONICAL_HOME_GROK_SESSION_PATH = new RegExp(
  CANONICAL_HOME_GROK_SESSION_PATH.source,
  "i",
);

/**
 * True when a path is Grok's session plan file under a Grok home
 * (`~/.grok/sessions/.../plan.md`, `$HOME/.grok/sessions/...`, or `$GROK_HOME/sessions/...`).
 * Deliberately does not match workspace files named `plan.md` (e.g. docs/plan.md
 * or a repo-local `.grok/sessions/.../plan.md`).
 */
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
  for (const prefix of grokPlanSessionPrefixes(host.environment)) {
    const needle = win32 ? prefix.toLowerCase() : prefix;
    if (!haystack.startsWith(needle)) {
      continue;
    }
    const rest = haystack.slice(needle.length);
    // Session layout: <home>/.grok/sessions/<encoded-cwd>/<session-id>/plan.md
    if (rest !== "plan.md" && rest.endsWith("plan.md")) {
      return true;
    }
  }
  return (
    win32 ? CASE_INSENSITIVE_CANONICAL_HOME_GROK_SESSION_PATH : CANONICAL_HOME_GROK_SESSION_PATH
  ).test(haystack);
}

/**
 * Extract plan markdown from a Grok write/edit tool call targeting plan.md.
 * Used so T3 can show the plan while plan mode is still active (before exit).
 */
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
          settleXAiPromptCompletion(entry.deferred, notification),
          [...pending.slice(0, index), ...pending.slice(index + 1)],
        ] as const;
      }).pipe(Effect.flatten);
    }),
  );

const settleXAiPromptCompletion = (
  deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpRequestError>,
  notification: XAiPromptCompleteNotification,
) => {
  if (notification.stopReason === "rate_limit") {
    return Deferred.fail(
      deferred,
      new EffectAcpErrors.AcpRequestError({
        code: xAiRateLimitedErrorCode,
        errorMessage: "Grok usage limit reached. Try again later.",
      }),
    ).pipe(Effect.asVoid);
  }
  if (notification.stopReason === "error") {
    return Deferred.fail(
      deferred,
      EffectAcpErrors.AcpRequestError.internalError(
        xAiAgentResultMessage(notification.agentResult) ?? "Grok prompt failed.",
      ),
    ).pipe(Effect.asVoid);
  }
  return Deferred.succeed(deferred, promptResponseFromXAi(notification)).pipe(Effect.asVoid);
};

function xAiAgentResultMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return trimmed(value);
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const message = "message" in value ? value.message : undefined;
  return typeof message === "string" ? trimmed(message) : undefined;
}

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
