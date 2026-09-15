/**
 * OmpAdapterLive — Oh My Pi CLI (`omp acp`) via ACP.
 *
 * @module OmpAdapterLive
 */

import {
  ApprovalRequestId,
  type OmpSettings,
  type ProviderOptionSelection,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeMode,
  type RuntimeTaskStatus,
  type RuntimeTaskUsage,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpToolCallState,
  parsePermissionRequest,
  sessionUpdateIsReplay,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyOmpAcpModelSelection,
  makeOmpAcpRuntime,
  resolveOmpAcpBaseModelId,
} from "../acp/OmpAcpSupport.ts";
import { type AnsiFilter, makeAnsiFilter } from "../acp/OmpAnsi.ts";
import { type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { rewriteOmpSkillMentions } from "../Drivers/OmpSkillDispatch.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("omp");
const OMP_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan"];
const ACP_IMPLEMENT_MODE_ALIASES = ["default"];

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface OmpAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`omp`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `ompSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<OmpSettings>;
  /**
   * Names of the skills discovered for a workspace, used to rewrite the
   * composer's `$name` mentions into omp's `/skill:<name>` commands. The
   * driver serves this from the catalog its workspace snapshot already
   * probed, so a turn never spawns a discovery process. Unknown names and an
   * empty set leave the prompt untouched.
   */
  readonly resolveSkillNames?: (cwd: string) => ReadonlySet<string>;
  /**
   * Receives omp's `available_commands_update` for a session: the session
   * cwd and the raw command entries, skill entries and all. The driver
   * folds them into the per-cwd catalog its startup probe built, so a
   * command (or skill) added while a session is open reaches the composer
   * without a new discovery process.
   */
  readonly onSessionCommands?: (
    cwd: string,
    commands: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
      readonly input?: { readonly hint: string };
    }>,
  ) => void;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface OmpSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  /** Turns interrupted while sendTurn was still preparing (before the prompt
   * reached the wire). acp.cancel is a no-op at that point, so sendTurn
   * checks this set at its prompt checkpoints instead. Entries are removed
   * when the turn settles. */
  readonly cancelledTurnIds: Set<TurnId>;
  /** omp subagent spawns (task tool calls) keyed by toolCallId, awaiting a
   * terminal tool_call_update so task.completed can repeat the linkage. */
  readonly ompSubagentTasks: Map<string, ReadonlyArray<OmpSubagentSpawn>>;
  /** Last emitted subagent snapshot per task id. omp repeats every agent's
   * full state on each tick, so only material changes become events. */
  readonly ompSubagentActivity: Map<string, string>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  /** Turn that already reported a model substitution, so a steer folded
   * into the same turn does not repeat the warning. */
  modelWarningTurnId: TurnId | undefined;
  lastPlanFingerprint: string | undefined;
  /** Strips omp's terminal escapes out of streamed message text. */
  readonly ansiFilter: AnsiFilter;
  activeTurnId: TurnId | undefined;
  /** Whether the active turn has streamed any assistant text yet. */
  turnProducedText: boolean;
  /** Context occupancy last reported by omp's `usage_update`. The
   * `session/prompt` response only carries per-turn tokens, so the context
   * meter keeps reading these until omp reports a new occupancy. */
  lastContextUsedTokens: number | undefined;
  lastContextWindowTokens: number | undefined;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  /** Serializes the session-configuration write and the session/prompt
   * dispatch registration for one ACP session: omp applies model writes to
   * the shared session, so two concurrent sendTurns must not interleave
   * set-A, set-B, prompt-A. The permit is held only from the configuration
   * write until the prompt is registered as active (or its fiber exits),
   * never across the prompt itself, so steers stay concurrent. */
  readonly dispatchLock: Semaphore.Semaphore;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOmpResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== OMP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  // omp only advertises `default` and `plan` modes; approval behavior is a
  // spawn-time concern (CLI approval flags), so every runtime mode resolves
  // to the implement mode here.
  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<{ readonly model: string | undefined }, E> {
  return Effect.gen(function* () {
    let appliedModel: string | undefined;
    if (input.modelSelection) {
      appliedModel = (yield* applyOmpAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        selections: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      })).model;
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return { model: appliedModel };
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
    return { model: appliedModel };
  });
}

/**
 * Maps an approval decision to the option id the agent actually advertised.
 * Matches on ACP `kind` (the contract) rather than free-form ids — omp's
 * PERMISSION_OPTIONS use snake_case. Edge cases carried from the review
 * guidance on #8583: options with blank ids are unusable and skipped; agents
 * that omit allow_always get "always allow this session" mapped onto their
 * allow_once; and when nothing usable exists the caller settles the request
 * as cancelled instead of answering with an id the agent never advertised.
 */
export function selectOmpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const pick = (kind: string) => {
    const match = request.options.find((option) => option.kind === kind);
    return typeof match?.optionId === "string" && match.optionId.trim().length > 0
      ? match.optionId.trim()
      : undefined;
  };
  switch (decision) {
    case "accept":
      return pick("allow_once");
    case "acceptForSession":
      return pick("allow_always") ?? pick("allow_once");
    default:
      return pick("reject_once") ?? pick("reject_always");
  }
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

/**
 * One omp subagent spawn parsed from a `task` tool call. omp exposes its
 * sub-agent dispatch as an ordinary ACP tool call whose `rawInput` matches
 * the CLI's task schema: `{ name?, agent, task, effort?, isolated? }` for a
 * single spawn, or `{ tasks: [...], context? }` to fan out several.
 */
interface OmpSubagentSpawn {
  readonly taskId: string;
  readonly title: string;
  readonly role?: string;
  readonly effort?: string;
}

const OMP_TASK_TITLE_MAX_CHARS = 80;
const OMP_TASK_RESULT_MAX_CHARS = 500;
const OMP_ELICITATION_TEXT_MAX_CHARS = 2_000;
const OMP_TURN_ERROR_MAX_CHARS = 1_000;

interface OmpElicitationPropertyLike {
  readonly type?: string | undefined;
  readonly title?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly enum?: ReadonlyArray<string> | null | undefined;
}

/**
 * Structural minimum of a form-mode elicitation request. Deliberately loose:
 * the same mapping serves both effect-acp's typed `session/elicitation`
 * handler and the flat `elicitation/create` fallback that omp's official ACP
 * SDK actually sends.
 */
export interface OmpElicitationFormLike {
  readonly mode?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly message?: string | undefined;
  readonly requestedSchema?:
    | {
        readonly type?: string | undefined;
        readonly properties?: Readonly<Record<string, OmpElicitationPropertyLike>> | undefined;
      }
    | undefined;
}

/**
 * Maps an omp form elicitation's JSON-schema properties onto T3 user-input
 * questions. Select-style properties (string+enum, boolean) get option lists;
 * everything else falls back to free text (the web composer supports custom
 * answers).
 */
export function ompElicitationQuestionsFromForm(
  params: OmpElicitationFormLike,
): ReadonlyArray<UserInputQuestion> {
  const fallbackQuestion = params.message?.trim() || "Oh My Pi requests input.";
  return Object.entries(params.requestedSchema?.properties ?? {}).map(([key, property]) => {
    const enumValues =
      property.type === "string"
        ? (property.enum ?? []).filter((value) => value.trim().length > 0)
        : [];
    return {
      id: key,
      header: property.title?.trim() || key,
      question: truncateTaskText(
        property.description?.trim() || fallbackQuestion,
        OMP_ELICITATION_TEXT_MAX_CHARS,
      ),
      multiSelect: false,
      options:
        enumValues.length > 0
          ? enumValues.map((value) => ({ label: value, description: value }))
          : property.type === "boolean"
            ? [
                { label: "True", description: "Yes" },
                { label: "False", description: "No" },
              ]
            : [],
    } satisfies UserInputQuestion;
  });
}

/**
 * Maps T3 user-input answers back onto an elicitation response content
 * object. Answer values are the selected option labels (or custom free text);
 * boolean properties translate the "True"/"False" labels back, array
 * properties keep string arrays. Keys without a usable answer are omitted.
 */
export function ompElicitationContentFromAnswers(
  params: OmpElicitationFormLike,
  answers: ProviderUserInputAnswers,
): Record<string, string | number | boolean | ReadonlyArray<string>> {
  const content: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
  for (const [key, property] of Object.entries(params.requestedSchema?.properties ?? {})) {
    const raw = answers[key];
    if (raw === undefined || raw === null) {
      continue;
    }
    if (property.type === "boolean") {
      const value =
        raw === true || raw === "True"
          ? true
          : raw === false || raw === "False"
            ? false
            : undefined;
      if (value !== undefined) {
        content[key] = value;
      }
      continue;
    }
    if (property.type === "array") {
      const values = Array.isArray(raw)
        ? raw.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          )
        : typeof raw === "string" && raw.trim().length > 0
          ? [raw]
          : [];
      if (values.length > 0) {
        content[key] = values;
      }
      continue;
    }
    if (typeof raw === "string" && raw.trim().length > 0) {
      content[key] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      content[key] = raw;
    } else if (Array.isArray(raw)) {
      const first = raw.find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      if (first !== undefined) {
        content[key] = first;
      }
    }
  }
  return content;
}

function truncateTaskText(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

/**
 * Name the slash command whose turn produced no assistant text, or
 * `undefined` when the prompt was not a bare command or text did arrive.
 * Only a prompt that is *only* a command counts: a sentence that happens to
 * start with a path (`/tmp/x is broken`) answers with text anyway, and a
 * command with a follow-up prompt attached is an ordinary turn.
 */
export function ompSilentCommandName(prompt: string, producedText: boolean): string | undefined {
  if (producedText) return undefined;
  const match = /^\/([A-Za-z][\w.:-]*)(?:\s+\S+)*\s*$/.exec(prompt.trim());
  return match?.[1];
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseOmpSubagentSpawnItem(
  taskId: string,
  item: Record<string, unknown>,
): OmpSubagentSpawn | undefined {
  const task = optionalTrimmedString(item.task);
  if (!task) {
    return undefined;
  }
  const role = optionalTrimmedString(item.agent);
  const effort = optionalTrimmedString(item.effort);
  return {
    taskId,
    title: truncateTaskText(optionalTrimmedString(item.name) ?? task, OMP_TASK_TITLE_MAX_CHARS),
    ...(role ? { role } : {}),
    ...(effort ? { effort } : {}),
  };
}

/**
 * Every key omp's task tool schema accepts. ACP does not carry the tool
 * name, so this allowlist is the identity check: any rawInput with a foreign
 * key (e.g. { task: "…", url: "…" }) belongs to another tool and must not be
 * projected as a subagent spawn.
 */
const OMP_TASK_TOOL_INPUT_KEYS: Record<string, true> = {
  name: true,
  agent: true,
  task: true,
  tasks: true,
  context: true,
  effort: true,
  isolated: true,
  outputSchema: true,
  schemaMode: true,
  label: true,
  apply: true,
  merge: true,
  handle: true,
};

export function parseOmpSubagentSpawns(
  toolCallId: string,
  rawInput: unknown,
): ReadonlyArray<OmpSubagentSpawn> {
  if (!isRecord(rawInput)) {
    return [];
  }
  if (!Object.keys(rawInput).every((key) => OMP_TASK_TOOL_INPUT_KEYS[key] === true)) {
    return [];
  }
  if (Array.isArray(rawInput.tasks)) {
    return rawInput.tasks.flatMap((item, index) => {
      if (!isRecord(item)) {
        return [];
      }
      const spawn = parseOmpSubagentSpawnItem(`${toolCallId}:${index}`, item);
      return spawn ? [spawn] : [];
    });
  }
  const single = parseOmpSubagentSpawnItem(toolCallId, rawInput);
  return single ? [single] : [];
}

/**
 * omp's task tool reports through the ordinary tool-call payload: its
 * result object is `{ content: [...], details: { progress?, results? } }`.
 * `content[].text` is the human summary, so a summary lookup has to reach
 * into the content blocks, not only flat string fields.
 */
function summarizeOmpTaskResult(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === "string") {
    return rawOutput.trim() ? truncateTaskText(rawOutput, OMP_TASK_RESULT_MAX_CHARS) : undefined;
  }
  if (!isRecord(rawOutput)) {
    return undefined;
  }
  const flat = ["output", "result", "text", "stdout"]
    .map((field) => rawOutput[field])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (flat) {
    return truncateTaskText(flat, OMP_TASK_RESULT_MAX_CHARS);
  }
  const content = rawOutput.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return truncateTaskText(content, OMP_TASK_RESULT_MAX_CHARS);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const blockText = content
    .flatMap((block) => (isRecord(block) && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
  return blockText.trim() ? truncateTaskText(blockText, OMP_TASK_RESULT_MAX_CHARS) : undefined;
}

/**
 * One omp subagent's state inside a `task` tool-call payload. omp streams
 * `details.progress` while agents run and `details.results` once they
 * settle; both are per-spawn arrays carrying the same identity fields, so
 * they are projected onto one shape.
 */
interface OmpSubagentActivity {
  readonly index: number | undefined;
  readonly status: RuntimeTaskStatus | undefined;
  /** `lastIntent` while running, the spawn's own description otherwise. */
  readonly description: string | undefined;
  readonly lastToolName: string | undefined;
  readonly summary: string | undefined;
  readonly error: string | undefined;
  readonly model: string | undefined;
  readonly usage: RuntimeTaskUsage | undefined;
}

const OMP_SUBAGENT_STATUSES: Record<string, RuntimeTaskStatus> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  // omp aborts a subagent on interrupt or runtime cap; T3's vocabulary
  // calls that cancelled.
  aborted: "cancelled",
};

function parseOmpSubagentActivity(entry: Record<string, unknown>): OmpSubagentActivity {
  const reportedStatus =
    typeof entry.status === "string" ? OMP_SUBAGENT_STATUSES[entry.status] : undefined;
  const error = optionalTrimmedString(entry.error);
  const exitCode = typeof entry.exitCode === "number" ? entry.exitCode : undefined;
  // Settled entries (`details.results`) carry no status field: omp encodes
  // the outcome as aborted / exitCode / error instead.
  const settledStatus =
    entry.aborted === true
      ? ("cancelled" as const)
      : exitCode === undefined
        ? undefined
        : exitCode === 0 && error === undefined
          ? ("completed" as const)
          : ("failed" as const);
  const recentTools = Array.isArray(entry.recentTools) ? entry.recentTools : [];
  const lastTool = recentTools.find(
    (tool): tool is Record<string, unknown> => isRecord(tool) && typeof tool.tool === "string",
  );
  const totalTokens = nonNegativeTokenCount(
    typeof entry.tokens === "number" ? entry.tokens : undefined,
  );
  const toolUses = nonNegativeTokenCount(
    typeof entry.toolCount === "number" ? entry.toolCount : undefined,
  );
  const durationMs = nonNegativeTokenCount(
    typeof entry.durationMs === "number" ? entry.durationMs : undefined,
  );
  const output = optionalTrimmedString(entry.output);
  return {
    index: typeof entry.index === "number" && entry.index >= 0 ? entry.index : undefined,
    status: reportedStatus ?? settledStatus,
    description:
      optionalTrimmedString(entry.lastIntent) ?? optionalTrimmedString(entry.description),
    lastToolName:
      optionalTrimmedString(entry.currentTool) ??
      (lastTool ? optionalTrimmedString(lastTool.tool) : undefined),
    summary: output
      ? truncateTaskText(output, OMP_TASK_RESULT_MAX_CHARS)
      : error
        ? truncateTaskText(error, OMP_TASK_RESULT_MAX_CHARS)
        : undefined,
    error: error ? truncateTaskText(error, OMP_TASK_RESULT_MAX_CHARS) : undefined,
    model: optionalTrimmedString(entry.resolvedModel),
    usage:
      totalTokens === undefined
        ? undefined
        : {
            totalTokens,
            ...(toolUses !== undefined ? { toolUses } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
          },
  };
}

/**
 * Splits a task tool-call payload into the in-flight and settled subagent
 * entries omp reported. Anything else in `details` (agent directories,
 * aggregate usage, output paths) belongs to the tool row, not the Agents
 * panel.
 */
export function parseOmpSubagentActivities(rawOutput: unknown): {
  readonly progress: ReadonlyArray<OmpSubagentActivity>;
  readonly results: ReadonlyArray<OmpSubagentActivity>;
} {
  const details = isRecord(rawOutput) ? rawOutput.details : undefined;
  if (!isRecord(details)) {
    return { progress: [], results: [] };
  }
  const read = (value: unknown) =>
    Array.isArray(value)
      ? value.flatMap((entry) => (isRecord(entry) ? [parseOmpSubagentActivity(entry)] : []))
      : [];
  return { progress: read(details.progress), results: read(details.results) };
}

function nonNegativeTokenCount(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

/**
 * Projects omp's two token-usage sources onto one context-meter snapshot.
 *
 * `usage_update` carries the session's context occupancy (`used` of `size`);
 * the `session/prompt` response carries the finished turn's token split. The
 * meter reads `usedTokens`/`maxTokens`, so a prompt response alone (no
 * context window observed yet) falls back to the turn's total and the
 * `last*` fields stay the per-turn numbers, matching Claude and Codex.
 *
 * omp also reports a cumulative `cost` on `usage_update`; the runtime token
 * snapshot has no currency field, so it is deliberately dropped here.
 */
function makeOmpTokenUsageSnapshot(input: {
  readonly contextUsedTokens?: number | null | undefined;
  readonly contextWindowTokens?: number | null | undefined;
  readonly turnUsage?: EffectAcpSchema.Usage | null | undefined;
}): ThreadTokenUsageSnapshot | undefined {
  const contextWindowTokens = nonNegativeTokenCount(input.contextWindowTokens);
  const maxTokens =
    contextWindowTokens !== undefined && contextWindowTokens > 0 ? contextWindowTokens : undefined;
  const turnTotalTokens = nonNegativeTokenCount(input.turnUsage?.totalTokens);
  const activeTokens = nonNegativeTokenCount(input.contextUsedTokens) ?? turnTotalTokens;
  if (activeTokens === undefined || activeTokens <= 0) {
    return undefined;
  }
  const usedTokens = maxTokens === undefined ? activeTokens : Math.min(activeTokens, maxTokens);
  const inputTokens = nonNegativeTokenCount(input.turnUsage?.inputTokens);
  const outputTokens = nonNegativeTokenCount(input.turnUsage?.outputTokens);
  const cachedInputTokens = nonNegativeTokenCount(input.turnUsage?.cachedReadTokens);
  const reasoningOutputTokens = nonNegativeTokenCount(input.turnUsage?.thoughtTokens);

  return {
    usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(turnTotalTokens !== undefined && turnTotalTokens > usedTokens
      ? { totalProcessedTokens: turnTotalTokens }
      : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(turnTotalTokens !== undefined ? { lastUsedTokens: turnTotalTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
  };
}

export function makeOmpAdapter(ompSettings: OmpSettings, options?: OmpAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("omp");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, OmpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Oh My Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: OmpSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload,
          }),
        );
      });

    /**
     * Publishes the context meter's feed. omp reports context occupancy on
     * `usage_update` and the per-turn split on the `session/prompt`
     * response, so both callers fold their numbers into the same snapshot
     * shape the other adapters emit.
     */
    const emitTokenUsage = (
      ctx: OmpSessionContext,
      usage: ThreadTokenUsageSnapshot,
      raw: { readonly method: string; readonly payload: unknown },
    ) =>
      Effect.gen(function* () {
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          payload: { usage },
          raw: {
            source: "acp.jsonrpc",
            method: raw.method,
            payload: raw.payload,
          },
        });
      });

    /**
     * Projects omp's `task` tool calls into Agents-panel lifecycle events.
     * The plain tool_call runtime event is still emitted alongside (Claude
     * shows its Task tool in the timeline as well).
     *
     * omp carries live subagent state inside the task tool's own payload:
     * `rawOutput.details.progress` while agents run, `details.results` once
     * they settle. Those arrays are the only subagent activity omp reports
     * over ACP, so every richer event below comes from them and nothing is
     * synthesized between ticks.
     */
    const emitOmpSubagentEvents = (ctx: OmpSessionContext, toolCall: AcpToolCallState) =>
      Effect.gen(function* () {
        let tracked = ctx.ompSubagentTasks.get(toolCall.toolCallId);
        if (tracked === undefined) {
          const spawns = parseOmpSubagentSpawns(toolCall.toolCallId, toolCall.data.rawInput);
          if (spawns.length === 0) {
            return;
          }
          ctx.ompSubagentTasks.set(toolCall.toolCallId, spawns);
          tracked = spawns;
          for (const spawn of spawns) {
            yield* offerRuntimeEvent({
              type: "task.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              payload: {
                taskId: RuntimeTaskId.make(spawn.taskId),
                taskType: "subagent",
                title: spawn.title,
                ...(spawn.role ? { role: spawn.role } : {}),
                ...(spawn.effort ? { effort: spawn.effort } : {}),
                toolUseId: toolCall.toolCallId,
              },
            });
          }
        }

        const spawns = tracked;
        // omp keys its entries by spawn index; a single spawn still reports
        // index 0 while its task id is the bare tool call id, so position in
        // the tracked array — not the reported index — resolves identity.
        const spawnFor = (activity: OmpSubagentActivity) =>
          spawns[activity.index ?? 0] ?? (spawns.length === 1 ? spawns[0] : undefined);
        const activities = parseOmpSubagentActivities(toolCall.data.rawOutput);
        const terminal = toolCall.status === "completed" || toolCall.status === "failed";

        for (const activity of activities.progress) {
          const spawn = spawnFor(activity);
          if (!spawn) {
            continue;
          }
          // omp repeats every agent's full snapshot on each tick; without a
          // material-change filter a fan-out of N agents costs N events per
          // tick for state the client already renders.
          const fingerprint = [
            activity.status ?? "",
            activity.description ?? "",
            activity.lastToolName ?? "",
            activity.error ?? "",
            activity.model ?? "",
            activity.usage?.totalTokens ?? "",
            activity.usage?.toolUses ?? "",
          ].join("\u001f");
          if (ctx.ompSubagentActivity.get(spawn.taskId) === fingerprint) {
            continue;
          }
          const previous = ctx.ompSubagentActivity.get(spawn.taskId);
          ctx.ompSubagentActivity.set(spawn.taskId, fingerprint);
          const linkage = {
            taskType: "subagent" as const,
            title: spawn.title,
            ...(spawn.role ? { role: spawn.role } : {}),
            ...(spawn.effort ? { effort: spawn.effort } : {}),
            ...(activity.model ? { model: activity.model } : {}),
            toolUseId: toolCall.toolCallId,
          };
          // A status-only tick is a status patch, not an activity row: the
          // Agents panel renders the two differently and a progress row with
          // no description would render blank.
          if (activity.status !== undefined && previous?.split("\u001f")[0] !== activity.status) {
            yield* offerRuntimeEvent({
              type: "task.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              payload: {
                taskId: RuntimeTaskId.make(spawn.taskId),
                status: activity.status,
                ...(activity.description ? { description: activity.description } : {}),
                ...(activity.error ? { error: activity.error } : {}),
                ...linkage,
              },
            });
          }
          if (activity.description === undefined) {
            continue;
          }
          yield* offerRuntimeEvent({
            type: "task.progress",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: {
              taskId: RuntimeTaskId.make(spawn.taskId),
              description: activity.description,
              ...(activity.status ? { status: activity.status } : {}),
              ...(activity.lastToolName ? { lastToolName: activity.lastToolName } : {}),
              ...(activity.error ? { error: activity.error } : {}),
              ...(activity.usage ? { typedUsage: activity.usage } : {}),
              ...linkage,
            },
          });
        }

        if (!terminal) {
          return;
        }
        ctx.ompSubagentTasks.delete(toolCall.toolCallId);
        const summary = summarizeOmpTaskResult(toolCall.data.rawOutput);
        const resultFor = new Map<string, OmpSubagentActivity>();
        for (const result of activities.results) {
          const spawn = spawnFor(result);
          if (spawn) {
            resultFor.set(spawn.taskId, result);
          }
        }
        for (const spawn of spawns) {
          ctx.ompSubagentActivity.delete(spawn.taskId);
          const result = resultFor.get(spawn.taskId);
          // Per-agent outcome wins over the tool call's: one failed agent in
          // a fan-out must not mark its siblings failed, and a fan-out that
          // fails overall must not report a succeeded agent as failed.
          const status =
            result?.status === "cancelled"
              ? ("stopped" as const)
              : result?.status === "failed"
                ? ("failed" as const)
                : result?.status === "completed"
                  ? ("completed" as const)
                  : toolCall.status === "failed"
                    ? ("failed" as const)
                    : ("completed" as const);
          const resolvedSummary = result?.summary ?? summary;
          yield* offerRuntimeEvent({
            type: "task.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: {
              taskId: RuntimeTaskId.make(spawn.taskId),
              status,
              ...(resolvedSummary ? { summary: resolvedSummary } : {}),
              ...(result?.usage ? { typedUsage: result.usage } : {}),
              taskType: "subagent",
              title: spawn.title,
              ...(spawn.role ? { role: spawn.role } : {}),
              ...(spawn.effort ? { effort: spawn.effort } : {}),
              ...(result?.model ? { model: result.model } : {}),
              toolUseId: toolCall.toolCallId,
            },
          });
        }
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<OmpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    // Thread locks are deliberately never removed from threadLocksRef:
    // deleting a lock while its permit is held or queued would let a later
    // startSession build a fresh semaphore and run concurrently with the
    // operations queued on the old one — worse than the bounded leak of one
    // semaphore per thread id.
    const stopSessionInternal = (ctx: OmpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: OmpAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const ompModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: OmpSessionContext;
          // Bound after `acp.start()`; the side-channel session/update
          // handler below is registered before the session exists and must
          // ignore notifications until a session id is known. `/fresh`
          // swaps omp's provider session mid-thread, so later ids join the
          // set rather than replacing it: omp still answers prompts on the
          // id the session was created with.
          const liveSessionIds = new Set<string>();

          const resumeSessionId = parseOmpResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          // Resolve the OmpSettings used to spawn the ACP child. Production
          // leaves `options.resolveSettings` undefined so we use the value
          // captured at adapter construction — per-instance isolation is
          // enforced by the hydration layer rebuilding this adapter whenever
          // its config changes. Tests set `resolveSettings` to pull the latest
          // snapshot from `ServerSettingsService` so that mid-suite
          // `updateSettings({ providers: { omp: { binaryPath } } })` calls
          // actually take effect when the next session spawns.
          const effectiveOmpSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : ompSettings;

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeOmpAcpRuntime({
            ompSettings: effectiveOmpSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            // Approval behavior is spawn-time for omp (CLI approval flags),
            // so the runtime mode travels into the spawn input here.
            runtimeMode: input.runtimeMode,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            // `/fresh` swaps omp's provider session; updates then arrive
            // under the new id, so the thread tracks it for routing. The
            // resume cursor keeps the id the session was created with:
            // that is the one `session/load` can replay.
            onAgentSessionIdChanged: (sessionId) => {
              liveSessionIds.add(sessionId);
            },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          // omp's extension wrapper asks for approval through ACP
          // elicitation. effect-acp types that as `session/elicitation`, but
          // omp 18.0.6's official @agent-client-protocol/sdk sends
          // `elicitation/create` — so both registrations share one flow. The
          // ext fallback controls its own wire format and answers with the
          // FLAT shape omp expects ({ action: "accept", content }), whereas
          // the typed handler keeps effect-acp's nested response schema.
          const runElicitationFlow = (
            method: string,
            rawParams: unknown,
            formParams: OmpElicitationFormLike,
          ) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, method, rawParams);
              const questions = ompElicitationQuestionsFromForm(formParams);
              if (questions.length === 0) {
                return { action: "cancel" as const };
              }
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const answers = yield* Deferred.make<ProviderUserInputAnswers>();
              pendingUserInputs.set(requestId, { answers });
              yield* offerRuntimeEvent({
                type: "user-input.requested",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                requestId: runtimeRequestId,
                payload: { questions: [...questions] },
                raw: {
                  source: "acp.jsonrpc",
                  method,
                  payload: rawParams,
                },
              });
              const resolved = yield* Deferred.await(answers);
              pendingUserInputs.delete(requestId);
              yield* offerRuntimeEvent({
                type: "user-input.resolved",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: ctx?.activeTurnId,
                requestId: runtimeRequestId,
                payload: { answers: resolved },
              });
              const content = ompElicitationContentFromAnswers(formParams, resolved);
              return Object.keys(content).length === 0
                ? { action: "cancel" as const }
                : { action: "accept" as const, content };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: "Failed to process Oh My Pi ACP elicitation request.",
                    cause,
                  }),
              ),
            );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                if (input.runtimeMode === "full-access") {
                  const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                  if (autoApprovedOptionId !== undefined) {
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: autoApprovedOptionId,
                      },
                    };
                  }
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, {
                  decision,
                  kind: permissionRequest.kind,
                });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail:
                      permissionRequest.detail ??
                      encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                      "[unserializable params]",
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                const optionId =
                  resolved === "cancel" ? undefined : selectOmpPermissionOptionId(params, resolved);
                return {
                  outcome:
                    optionId === undefined
                      ? ({ outcome: "cancelled" } as const)
                      : ({ outcome: "selected" as const, optionId } as const),
                };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      detail: "Failed to process Oh My Pi ACP permission request.",
                      cause,
                    }),
                ),
              ),
            );
            yield* acp.handleElicitation((params) =>
              params.mode !== "form"
                ? Effect.succeed({ action: { action: "cancel" as const } })
                : runElicitationFlow("session/elicitation", params, params).pipe(
                    Effect.map((flat) => ({ action: flat })),
                  ),
            );
            yield* acp.handleUnknownExtRequest((method, params) => {
              if (method !== "elicitation/create") {
                return Effect.fail(EffectAcpErrors.AcpRequestError.methodNotFound(method));
              }
              if (!isRecord(params) || (params.mode !== undefined && params.mode !== "form")) {
                return Effect.succeed({ action: "cancel" as const });
              }
              return runElicitationFlow("elicitation/create", params, params);
            });
            // Side channel for the session/update kinds the shared ACP
            // parser drops or routes elsewhere: `usage_update` (context
            // meter), a `plan` with zero entries (omp's todo_auto_clear,
            // which the todo panel reads as "clear the plan"), and
            // `available_commands_update` (the driver's per-cwd command
            // catalog). Handlers are additive, so the runtime's own parser
            // still owns every other update kind; this one drains the
            // runtime's event queue first so a clear can never overtake the
            // plan it clears.
            yield* acp.handleSessionUpdate((notification) =>
              Effect.gen(function* () {
                const sessionCtx = sessions.get(input.threadId);
                const update = notification.update;
                if (!liveSessionIds.has(notification.sessionId)) {
                  return;
                }
                // The command catalog is session state, not turn content:
                // it arrives before `sessions` has the context (omp
                // publishes it during session setup) and a replayed copy on
                // session/load is still the current catalog, so it is
                // forwarded under a looser gate than the timeline kinds.
                if (update.sessionUpdate === "available_commands_update") {
                  if (sessionCtx?.stopped === true) {
                    return;
                  }
                  yield* logNative(input.threadId, "session/update", notification);
                  yield* Effect.sync(() =>
                    options?.onSessionCommands?.(
                      cwd,
                      // Names keep omp's own prefixes (`skill:` included);
                      // only optional fields are narrowed to the shape the
                      // driver's catalog reads.
                      update.availableCommands.map((command) => ({
                        name: command.name,
                        ...(typeof command.description === "string"
                          ? { description: command.description }
                          : {}),
                        ...(command.input && typeof command.input.hint === "string"
                          ? { input: { hint: command.input.hint } }
                          : {}),
                      })),
                    ),
                  );
                  return;
                }
                if (
                  sessionCtx === undefined ||
                  sessionCtx.stopped ||
                  sessionCtx.acp !== acp ||
                  sessionUpdateIsReplay(notification)
                ) {
                  return;
                }
                if (update.sessionUpdate === "usage_update") {
                  yield* logNative(sessionCtx.threadId, "session/update", notification);
                  sessionCtx.lastContextUsedTokens =
                    nonNegativeTokenCount(update.used) ?? sessionCtx.lastContextUsedTokens;
                  sessionCtx.lastContextWindowTokens =
                    nonNegativeTokenCount(update.size) ?? sessionCtx.lastContextWindowTokens;
                  const usage = makeOmpTokenUsageSnapshot({
                    contextUsedTokens: sessionCtx.lastContextUsedTokens,
                    contextWindowTokens: sessionCtx.lastContextWindowTokens,
                  });
                  if (!usage) {
                    return;
                  }
                  yield* acp.drainEvents;
                  yield* emitTokenUsage(sessionCtx, usage, {
                    method: "session/update",
                    payload: notification,
                  });
                  return;
                }
                // `/rename` (and omp's own auto-titling) renames the session
                // omp shows in `--resume`. The thread title is the same name
                // in this client, so it follows omp's rather than keeping a
                // stale one.
                if (update.sessionUpdate === "session_info_update") {
                  const title = typeof update.title === "string" ? update.title.trim() : undefined;
                  if (title === undefined || title.length === 0) {
                    return;
                  }
                  yield* logNative(sessionCtx.threadId, "session/update", notification);
                  yield* offerRuntimeEvent({
                    type: "thread.metadata.updated",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: sessionCtx.threadId,
                    payload: { name: title, nameIsExplicit: true },
                  });
                  return;
                }
                if (update.sessionUpdate === "plan" && update.entries.length === 0) {
                  yield* logNative(sessionCtx.threadId, "session/update", notification);
                  yield* acp.drainEvents;
                  yield* emitPlanUpdate(sessionCtx, { plan: [] }, notification);
                }
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      detail: "Failed to process Oh My Pi ACP session update.",
                      cause,
                    }),
                ),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );
          liveSessionIds.add(started.sessionId);

          const startConfiguration = yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: ompModelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: startConfiguration.model ?? resolveOmpAcpBaseModelId(ompModelSelection?.model),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: OMP_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const dispatchLock = yield* Semaphore.make(1);
          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            cancelledTurnIds: new Set(),
            ompSubagentTasks: new Map(),
            ompSubagentActivity: new Map(),
            turns: [],
            lastPlanFingerprint: undefined,
            ansiFilter: makeAnsiFilter(),
            activeTurnId: undefined,
            turnProducedText: false,
            modelWarningTurnId: undefined,
            lastContextUsedTokens: undefined,
            lastContextWindowTokens: undefined,
            promptsInFlight: 0,
            dispatchLock,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted": {
                    // A chunk boundary can split an escape sequence, so the
                    // stripper holds a partial tail back: release whatever
                    // turned out to be real text before closing the item.
                    const tail = ctx.ansiFilter.flush();
                    if (tail.length > 0) {
                      yield* offerRuntimeEvent(
                        makeAcpContentDeltaEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: ctx.activeTurnId,
                          itemId: event.itemId,
                          text: tail,
                          rawPayload: undefined,
                        }),
                      );
                    }
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  }
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    yield* emitOmpSubagentEvents(ctx, event.toolCall);
                    return;
                  case "ThoughtDelta":
                  case "ContentDelta": {
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    // omp writes terminal output into chat text (`/context`
                    // draws colored bars), and the escapes would render as
                    // literal `[38;2;…m` noise.
                    const text = ctx.ansiFilter.push(event.text);
                    if (event._tag === "ContentDelta") {
                      ctx.turnProducedText = true;
                    }
                    if (text.length === 0) {
                      return;
                    }
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event._tag === "ContentDelta" && event.itemId
                          ? { itemId: event.itemId }
                          : {}),
                        ...(event._tag === "ThoughtDelta"
                          ? { streamKind: "reasoning_text" as const }
                          : {}),
                        text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Oh My Pi runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber. `forkChild`
            // makes this a child of `startSession`, and Effect interrupts a
            // fiber's children when it completes, so the consumer died as soon
            // as `startSession` returned and every later notification was
            // dropped. The scope is created, stored on the context and closed
            // on teardown already; only the fork target was wrong.
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Oh My Pi ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: OmpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A sendTurn while a prompt is in flight is a steer: the agent folds
        // the new prompt into the ongoing work, so the active turn id is
        // reused instead of opening a new turn.
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        // Count this prompt immediately so a superseded in-flight prompt
        // resolving from here on does not settle the turn; the matching
        // decrement is the `ensuring` below. Bind the active turn id in the
        // same synchronous stretch: after the increment, a concurrent
        // sendTurn must already see this turn id or it would steer onto the
        // previous one.
        ctx.promptsInFlight += 1;
        ctx.activeTurnId = turnId;
        if (steeringTurnId === undefined) {
          ctx.turnProducedText = false;
        }

        // interruptTurn cannot reach a turn whose prompt has not been sent
        // yet (acp.cancel is a no-op pre-prompt), so cancelled turn ids are
        // checked at both checkpoints instead.
        const settleIfCancelled = () =>
          Effect.gen(function* () {
            if (!ctx.cancelledTurnIds.has(turnId)) {
              return false;
            }
            if (ctx.promptsInFlight === 1) {
              ctx.cancelledTurnIds.delete(turnId);
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { state: "cancelled", stopReason: "cancelled" },
              });
            }
            // With other prompts in flight the mark stays put: deleting it
            // here would let the remaining prompts reach acp.prompt, and the
            // last one to finish (see `ensuring` below) settles the turn.
            return true;
          });

        let turnStartedEmitted = false;
        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          const resolvedModel = resolveOmpAcpBaseModelId(model);
          // Session configuration (model + options + mode) is applied as late
          // as possible — immediately before dispatch — so a concurrent
          // sendTurn cannot interleave a different model write between this
          // turn's configuration and its prompt.
          if (steeringTurnId === undefined) {
            ctx.lastPlanFingerprint = undefined;
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          if (yield* settleIfCancelled()) {
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          if (input.input?.trim()) {
            const promptText = input.input.trim();
            const sessionCwd = ctx.session.cwd;
            const dispatchedPrompt =
              options?.resolveSkillNames && sessionCwd
                ? rewriteOmpSkillMentions(promptText, options.resolveSkillNames(sessionCwd))
                : undefined;
            promptParts.push({ type: "text", text: dispatchedPrompt ?? promptText });
          }
          if (input.attachments && input.attachments.length > 0) {
            for (const attachment of input.attachments) {
              // omp ingests images only. Generic files reach the agent
              // through the path line ProviderService puts in the prompt.
              if (attachment.type !== "image") {
                continue;
              }
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              promptParts.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }
          }

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }
          if (yield* settleIfCancelled()) {
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }

          const dispatched = yield* Deferred.make<void>();
          const promptEffect = ctx.acp
            .prompt({ prompt: promptParts }, { dispatched })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );
          // omp applies model writes to the shared ACP session, so the
          // configuration write, the turn.started stamp, and the prompt's
          // dispatch registration must be atomic per session: without the
          // lock two concurrent sendTurns could interleave set-A, set-B,
          // prompt-A and run prompt A under model B. The permit is released
          // as soon as the prompt registers as active (or its fiber exits
          // without registering), never held across the prompt itself, so
          // steers stay concurrent.
          const { configuration, promptFiber } = yield* ctx.dispatchLock.withPermit(
            Effect.gen(function* () {
              const configuration = yield* applyRequestedSessionConfiguration({
                runtime: ctx.acp,
                runtimeMode: ctx.session.runtimeMode,
                interactionMode: input.interactionMode,
                modelSelection:
                  model === undefined
                    ? undefined
                    : {
                        model,
                        options: turnModelSelection?.options,
                      },
                mapError: ({ cause, method }) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
              });
              // Cancel checkpoint inside the permit: a turn interrupted
              // while its configuration write was in flight must never
              // stamp turn.started or register a session/prompt.
              if (yield* settleIfCancelled()) {
                return {
                  configuration,
                  promptFiber: undefined as
                    | Fiber.Fiber<EffectAcpSchema.PromptResponse, ProviderAdapterError>
                    | undefined,
                };
              }
              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload:
                    (configuration.model ?? resolvedModel)
                      ? { model: configuration.model ?? resolvedModel }
                      : {},
                });
                turnStartedEmitted = true;
              }
              const promptFiber = yield* promptEffect.pipe(Effect.forkIn(ctx.scope));
              yield* Deferred.await(dispatched).pipe(
                Effect.race(Fiber.await(promptFiber).pipe(Effect.asVoid)),
              );
              return {
                configuration,
                promptFiber: promptFiber as
                  | Fiber.Fiber<EffectAcpSchema.PromptResponse, ProviderAdapterError>
                  | undefined,
              };
            }),
          );
          const effectiveModel = configuration.model ?? resolvedModel;

          // omp keeps its configured model when the requested slug is not
          // advertised by the session (see applyOmpAcpModelSelection): the
          // turn still runs, but a different model answers it. Say so once
          // per turn instead of letting the substitution pass silently.
          if (
            resolvedModel !== undefined &&
            configuration.model !== resolvedModel &&
            ctx.modelWarningTurnId !== turnId
          ) {
            ctx.modelWarningTurnId = turnId;
            const answering = configuration.model ?? "its configured model";
            yield* offerRuntimeEvent({
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                message: `Oh My Pi does not offer '${resolvedModel}' in this session and answered with ${answering} instead.`,
                detail: {
                  requestedModel: resolvedModel,
                  ...(configuration.model ? { effectiveModel: configuration.model } : {}),
                },
              },
            });
          }

          if (promptFiber === undefined) {
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }

          if (yield* settleIfCancelled()) {
            // The cancel landed after dispatch registration: interrupt the
            // prompt fiber so no session/prompt outlives the cancelled turn.
            yield* Fiber.interrupt(promptFiber);
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }

          const result = yield* Fiber.join(promptFiber).pipe(
            // join does not propagate interruption to the joined fiber: an
            // interruptTurn or stopSession landing here would otherwise
            // orphan a live session/prompt.
            Effect.onInterrupt(() => Fiber.interrupt(promptFiber)),
          );

          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          if (turnRecord) {
            turnRecord.items.push({ prompt: promptParts, result });
          } else {
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            ...(effectiveModel ? { model: effectiveModel } : {}),
          };

          // The prompt response's per-turn split lands before the turn
          // settles so the meter never shows a finished turn with stale
          // numbers. Context occupancy still comes from the last
          // `usage_update`; omp reports no window on this response.
          const promptUsage = makeOmpTokenUsageSnapshot({
            contextUsedTokens: ctx.lastContextUsedTokens,
            contextWindowTokens: ctx.lastContextWindowTokens,
            turnUsage: result.usage,
          });
          if (promptUsage && !ctx.stopped) {
            yield* emitTokenUsage(ctx, promptUsage, {
              method: "session/prompt",
              payload: result,
            });
          }

          // Only the last remaining prompt settles the turn — a steer-
          // superseded prompt resolving (usually cancelled) while another is
          // in flight or pending must leave the merged turn running.
          if (ctx.promptsInFlight === 1 && !ctx.stopped) {
            // Some omp commands only draw into its own terminal UI
            // (`/instinct-status` and friends): over ACP the turn completes
            // with no text at all, which reads as "nothing happened". Name
            // the command that stayed silent instead.
            const silentCommand = ompSilentCommandName(input.input ?? "", ctx.turnProducedText);
            if (silentCommand !== undefined) {
              yield* offerRuntimeEvent({
                type: "runtime.warning",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  message: `Oh My Pi ran /${silentCommand} without returning any output — that command only renders in its own terminal UI.`,
                  detail: { command: silentCommand },
                },
              });
            }
            ctx.cancelledTurnIds.delete(turnId);
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: result.stopReason ?? null,
              },
            });
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          // A failure after turn.started must still close the turn: surface
          // it as turn.completed(failed) before the error propagates so the
          // UI never waits on a dead turn. Same settle rule as the success
          // path — only the last remaining prompt may settle.
          Effect.tapError((error) =>
            ctx.promptsInFlight !== 1 ||
            ctx.stopped || // session torn down or replaced mid-flight; a late failure must not publish on a dead/new session
            (!turnStartedEmitted && steeringTurnId === undefined)
              ? Effect.void
              : Effect.gen(function* () {
                  ctx.cancelledTurnIds.delete(turnId);
                  const message =
                    typeof error === "object" && error !== null && "message" in error
                      ? error.message
                      : undefined;
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      state: "failed",
                      stopReason: null,
                      errorMessage: truncateTaskText(
                        typeof message === "string" ? message : String(error),
                        OMP_TURN_ERROR_MAX_CHARS,
                      ),
                    },
                  });
                }),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
              // The last prompt of a turn cancelled during preparation
              // settles it here: the checkpoints kept the mark because other
              // prompts were still in flight.
              if (ctx.promptsInFlight === 0 && !ctx.stopped && ctx.cancelledTurnIds.has(turnId)) {
                // Finalizers cannot fail; a crypto failure here must not
                // mask the sendTurn outcome.
                yield* Effect.ignore(
                  Effect.gen(function* () {
                    ctx.cancelledTurnIds.delete(turnId);
                    yield* offerRuntimeEvent({
                      type: "turn.completed",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      payload: { state: "cancelled", stopReason: "cancelled" },
                    });
                  }),
                );
              }
            }),
          ),
        );
      });

    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // A late interrupt for a turn that already settled must not cancel
        // the thread's CURRENT turn: only act when the id matches (or none
        // was given, the legacy "cancel whatever is active" form).
        if (turnId !== undefined && turnId !== ctx.activeTurnId) {
          return;
        }
        // Pre-prompt cancellation cannot ride acp.cancel (a no-op until the
        // prompt is on the wire); sendTurn checks this set at its prompt
        // checkpoints and settles the turn as cancelled instead.
        if (ctx.activeTurnId !== undefined) {
          ctx.cancelledTurnIds.add(ctx.activeTurnId);
        }
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: OmpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: OmpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/user_input",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: OmpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: OmpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: OmpAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Oh My Pi session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      // omp's ACP session cannot rewind its native conversation history:
      // rollbackThread only truncates the local turn log, so advertise the
      // capability as unsupported instead of reporting a rollback the live
      // session does not reflect.
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      // omp exposes compaction as its own `/compact` command, not as an ACP
      // method, so ProviderService dispatches it as an ordinary turn (same
      // shape as Cursor's `/compress`) and settles on that turn's
      // turn.completed.
      compaction: { type: "slash-command", command: "/compact" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies OmpAdapterShape;
  });
}
