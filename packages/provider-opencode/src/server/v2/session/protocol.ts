/**
 * Pure OpenCode 2 protocol helpers: ids, rules, models, requests and message projections.
 */
import {
  Model,
  Provider,
  SessionMessage,
} from "@opencode/client/effect";
import type { OrchestrationV2ProviderThread, OrchestrationV2ProviderTurn, OrchestrationV2UserInputQuestion, ProviderApprovalDecision } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as OpenCodeRuntime from "../../OpenCodeRuntime.ts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { OPENCODE_PROVIDER } from "../../adapter.ts";
import type { ActiveTurn, ModelRef, NativeForm, Rule, RulesPolicy } from "./types.ts";

export const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect });

/** OpenCode hides tools for names over 64 chars and rejects names over 100; hash long thread IDs. */
export const t3McpServerName = Effect.fn("t3McpServerName")(function* (threadId: string) {
  const name = `t3-code-${threadId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (name.length <= 64) return name;
  const crypto = yield* Digest.Digest;
  const digest = yield* crypto
    .digest(Digest.sha256, new TextEncoder().encode(threadId))
    .pipe(Effect.orDie);
  return `t3-code-${Hex.encode(digest).slice(0, 16)}`;
});

// Last match wins: deny all threads' T3 servers, then allow only this thread's.
export const mcpRules = (mcpServerName: string | null): ReadonlyArray<Rule> =>
  mcpServerName === null
    ? []
    : [
        { action: "t3-code-*", resource: "*", effect: "deny" },
        { action: `${mcpServerName}_*`, resource: "*", effect: "allow" },
      ];

export const sessionRules = (
  policy: RulesPolicy,
  paths: ReadonlyArray<Rule>,
  grants: ReadonlyArray<Rule>,
  mcpServerName: string | null,
): ReadonlyArray<Rule> => [
  ...(policy.runtimeMode === "full-access"
    ? [rule("*", "allow")]
    : [
        rule("shell", "ask"),
        rule("edit", policy.runtimeMode === "auto-accept-edits" ? "allow" : "ask"),
        rule("external_directory", "ask"),
      ]),
  ...grants,
  // Plan edits are re-allowed only for plan paths; free-tier sessions refuse denied shell/read.
  ...(policy.interactionMode === "plan" ? [rule("edit", "deny")] : []),
  ...paths,
  ...mcpRules(mcpServerName),
];

export const sameRules = (left: ReadonlyArray<Rule> | undefined, right: ReadonlyArray<Rule>) =>
  left?.length === right.length &&
  left.every(
    (entry, index) =>
      entry.action === right[index]?.action &&
      entry.resource === right[index]?.resource &&
      entry.effect === right[index]?.effect,
  );

// Rejection without a message stops the whole execution, meaning Cancel.
export const DECLINED = "The user declined this request.";

// Steer before decline; otherwise the model sees only Unable to execute command and retries.
export const declinedNote = (action: string, resources: ReadonlyArray<string>) =>
  `The user declined the ${action} request${resources.length === 0 ? "" : ` (${resources.join(", ")})`}. Do not retry it; continue without it or ask the user how to proceed.`;

export const sessionGrantLabel = (action: string, save: ReadonlyArray<string>) =>
  save.every((pattern) => pattern === "*")
    ? `Allow every ${action} request this session`
    : `Allow ${save.join(", ")} this session`;

export const text = (value: string | undefined, fallback: string) => value?.trim() || fallback;

export const formQuestions = (
  form: NativeForm,
):
  | { readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion> }
  | { readonly unsupported: string } => {
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [index, field] of form.fields.entries()) {
    if (field.type === "external") return { unsupported: "a link to open" };
    if (field.type !== "string" && field.type !== "multiselect") {
      return { unsupported: `a ${field.type} value` };
    }
    if (field.hidden === true) return { unsupported: "a hidden field" };
    if ((field.when?.length ?? 0) > 0) return { unsupported: "a field that depends on another" };
    const header = text(field.title, `Question ${index + 1}`);
    const options = (field.options ?? []).map((option) => {
      const label = text(option.label, text(option.value, "Option"));
      return { label, description: text(option.description, label), value: option.value };
    });
    questions.push({
      id: field.key,
      header,
      question: text(field.description, header),
      options,
      multiSelect: field.type === "multiselect",
      allowCustomAnswer: field.custom === true || options.length === 0,
    });
  }
  return { questions };
};

export const formAnswer = (form: NativeForm, answers: Readonly<Record<string, unknown>>) => {
  const answer: Record<string, string | ReadonlyArray<string>> = {};
  for (const field of form.fields) {
    const raw = answers[field.key];
    const values = (Array.isArray(raw) ? raw : [raw]).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (values.length > 0) {
      answer[field.key] = field.type === "multiselect" ? values : values.join(", ");
    }
  }
  return answer;
};

export const approves = (decision: ProviderApprovalDecision) =>
  decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";

export const permissionGone = {
  PermissionNotFoundError: () => Effect.void,
  SessionNotFoundError: () => Effect.void,
};
export const formGone = {
  FormNotFoundError: () => Effect.void,
  FormAlreadySettledError: () => Effect.void,
  SessionNotFoundError: () => Effect.void,
};

export const agentPaths = (rules: ReadonlyArray<Rule>) =>
  rules.filter(
    (entry) =>
      entry.effect === "allow" &&
      entry.resource !== "*" &&
      (entry.action === "edit" || entry.action === "external_directory"),
  );

export const ref = (nativeId: string, strength: "strong" | "weak" = "strong") => ({
  driver: OPENCODE_PROVIDER,
  nativeId,
  strength,
});

export const sessionIdOf = (providerThread: OrchestrationV2ProviderThread) => {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  return nativeId === undefined || nativeId === null
    ? Effect.fail(
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver: OPENCODE_PROVIDER,
          detail: `Provider thread ${providerThread.id} has no OpenCode session`,
        }),
      )
    : Effect.succeed(nativeId);
};

export const textOf = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

export const stringField = (record: Readonly<Record<string, unknown>> | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

export const reportOutcome = (state: string | undefined) =>
  state === "completed"
    ? ("completed" as const)
    : state === "error"
      ? ("failed" as const)
      : state === "cancelled"
        ? ("cancelled" as const)
        : ("unknown" as const);

export const subagentOutput = (text: string) =>
  /^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>$/.exec(text.trim())?.[1] ?? text;

export const isContinuation = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  turnInput.message.createdBy === "agent" && turnInput.message.creationSource === "provider";

export const wakeTurnId = (sessionId: string, attemptId: string) => `${sessionId}:wake:${attemptId}`;
export const isWakeTurn = (turn: OrchestrationV2ProviderTurn) =>
  turn.nativeTurnRef?.nativeId?.includes(":wake:") === true;

// OpenCode's claude-agent reports a spent Claude plan as provider.unknown with Claude's own text.
export const claudeUsageLimit = (message: string | undefined) =>
  message !== undefined && /^You've hit your [^\n·]*\blimit\b/.test(message)
    ? { resetAt: /\bResets at (\d{4}-\d\d-\d\dT[\d:.]+Z)\.?\s*$/.exec(message)?.[1] ?? null }
    : undefined;

export const INTERRUPT_TIMEOUT = "10 seconds";
export const INSTRUCTIONS_KEY = "t3-code";
export const RECONNECT_ATTEMPTS = 5;
export const RECONNECT_DELAY = "2 seconds";
export const RECONCILE_TIMEOUT = "15 seconds";
export const RECONNECT_WAIT = "30 seconds";
export const LOST_BACKGROUND =
  "T3 Code lost its connection to OpenCode while this subagent ran, so its result is not shown.";
export const INVENTORY_TIMEOUT = "5 seconds";
export const ACTIVE_CHECK_TIMEOUT = "5 seconds";
// Other failures may still have admitted the prompt.
export const CLEAR_PROMPT_REJECTIONS: ReadonlySet<string> = new Set([
  "InvalidRequestError",
  "ConflictError",
  "UnauthorizedError",
  "CommandNotFoundError",
  "SkillNotFoundError",
]);

export const OPENCODE_2_STILL_STOPPING =
  "OpenCode is still stopping the previous turn. Send the message again in a moment.";
export const REQUEST_REPLY_TIMEOUT = "10 seconds";

export const deliver = <E>(answer: Effect.Effect<void, E>) =>
  answer.pipe(
    Effect.retry({ times: 1 }),
    Effect.timeout(REQUEST_REPLY_TIMEOUT),
    Effect.exit,
    Effect.map(Exit.isSuccess),
  );


// msg_ IDs cannot cross sessions; include session identity because T3 IDs repeat across environments.
// Pre-acknowledgement IDs also establish fork/rollback boundaries.
export const turnPromptId = (sessionId: string, attemptId: string) =>
  SessionMessage.ID.make(`msg_t3_turn_${sessionId}:${attemptId}`);
export const steerPromptId = (sessionId: string, messageId: string) =>
  SessionMessage.ID.make(`msg_t3_steer_${sessionId}:${messageId}`);

export const promptOf = (turn: OrchestrationV2ProviderTurn) => {
  const nativeId = turn.nativeTurnRef?.nativeId;
  return nativeId?.startsWith("msg_") === true ? nativeId : undefined;
};

export const boundaryAfter = (
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerThreadId: OrchestrationV2ProviderThread["id"],
  kept: OrchestrationV2ProviderTurn | undefined,
  prompts: ReadonlySet<string>,
) => {
  const later = turns
    .filter(
      (turn) =>
        turn.providerThreadId === providerThreadId &&
        (kept === undefined || turn.ordinal > kept.ordinal),
    )
    .toSorted((left, right) => left.ordinal - right.ordinal);
  if (later.some((turn) => promptOf(turn) === undefined && !isWakeTurn(turn))) {
    return Effect.fail(
      new ProviderAdapter.ProviderAdapterProtocolError({
        driver: OPENCODE_PROVIDER,
        detail:
          "This OpenCode conversation has turns from an earlier T3 Code version, so it can't be cut there.",
      }),
    );
  }
  return Effect.succeed(
    later.map(promptOf).find((messageId) => messageId !== undefined && prompts.has(messageId)) ??
      null,
  );
};

export const isProviderAdapterError = Schema.is(ProviderAdapter.ProviderAdapterV2Error);

export const modelRef = (selection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"]) => {
  const parsed = OpenCodeRuntime.parseOpenCodeModelSlug(selection.model);
  if (parsed === null) return undefined;
  const variant = getModelSelectionStringOptionValue(selection, "variant");
  return Model.Ref.make({
    providerID: Provider.ID.make(parsed.providerID),
    id: Model.ID.make(parsed.modelID),
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
  });
};
export const malformedModel = (model: string) =>
  `OpenCode model '${model}' must use provider/model format`;
export const sameModel = (left: ModelRef, right: ModelRef | undefined) =>
  left.providerID === right?.providerID &&
  left.id === right?.id &&
  (left.variant ?? "default") === (right?.variant ?? "default");

export const agentFor = (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  input.runtimePolicy.interactionMode === "plan" ? "plan" : "build";

export const commandOf = (text: string) => {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match === null ? undefined : { name: match[1]!, text: match[2] ?? "" };
};

export const skillMentions = (text: string) => [
  ...new Set([...text.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => match[2] ?? [])),
];

export const turnTokenUsage = (turn: ActiveTurn, status: OrchestrationV2ProviderTurn["status"]) => {
  // A step whose start was missed, in a reconnect gap or as an unreadable event, ran on an unreported model.
  const models =
    turn.models.size === 0 || turn.missedEvents || turn.steps > turn.startedSteps
      ? {}
      : { models: [...turn.models] };
  return turn.steps === 0
    ? {
        usageScope: "main_agent" as const,
        usageStatus: "unavailable" as const,
        hasSubagents: turn.usedSubagents,
        ...models,
      }
    : {
        ...models,
        usageScope: "main_agent" as const,
        usageStatus:
          status === "completed" && !turn.missedEvents && turn.steps >= turn.startedSteps
            ? ("complete" as const)
            : ("partial" as const),
        inputTokens: turn.usage.input,
        cachedInputTokens: turn.usage.cached,
        cacheCreationTokens: turn.usage.cacheWrite,
        outputTokens: turn.usage.output,
        reasoningTokens: turn.usage.reasoning,
        hasSubagents: turn.usedSubagents,
      };
};
