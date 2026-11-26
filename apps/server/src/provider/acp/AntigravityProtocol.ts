import type {
  ProviderApprovalOption,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as AcpWireSchema from "effect-acp/schema-v1";

import {
  ACP_RAW_INPUT_PATH_KEYS,
  acpChangedPathsOfToolCall,
} from "@t3tools/provider-acp/server/clientPolicy";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import { parseElicitationForm } from "@t3tools/provider-acp/server/elicitationForm";
import {
  extractMcpToolCallIdentity,
  type AcpToolCallState,
} from "@t3tools/provider-acp/server/runtimeModel";

import {
  ANTIGRAVITY_EDIT_DIFF_OMITTED,
  antigravityEditPatch,
  isAntigravitySnippetPatch,
  readAntigravityPreEditFile,
} from "./AntigravityEditLocation.ts";

const TOOL_TEXT_LIMIT = 8_000;
const TOOL_TEXT_TRUNCATED = "[Earlier output truncated]\n\n";
const COMMAND_LINE_TRUNCATED = "\n\n[Command truncated]";
const QUESTION_LABEL_LIMIT = 512;

const NativeToolFields = Schema.Struct({
  command: Schema.optional(Schema.String),
  CommandLine: Schema.optional(Schema.String),
  command_line: Schema.optional(Schema.String),
  commandLine: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  Cwd: Schema.optional(Schema.String),
  WorkingDirectory: Schema.optional(Schema.String),
  working_dir: Schema.optional(Schema.String),
  workingDir: Schema.optional(Schema.String),
  combinedOutput: Schema.optional(Schema.String),
  combined_output: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Int),
  exit_code: Schema.optional(Schema.Int),
  imagePath: Schema.optional(Schema.String),
});
const decodeNativeToolFields = Schema.decodeUnknownOption(NativeToolFields);
const decodeSingleAnswer = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Tuple([Schema.String])]),
);
const decodeToolCallContent = Schema.decodeUnknownOption(AcpWireSchema.ToolCallContent);

// agy keeps its own `schedule` call in progress until the wake fires, then replies by itself.
const ANTIGRAVITY_SCHEDULE_TITLES = new Set(["Run schedule", "Running schedule"]);

/**
 * The agent goes on running a command or a scheduled wake after its prompt ends, and replies by
 * itself when it finishes. A daemon may never finish.
 */
export function antigravityToolOutlivesPrompt(toolCall: AcpToolCallState): boolean {
  if (toolCall.title !== undefined && ANTIGRAVITY_SCHEDULE_TITLES.has(toolCall.title)) return true;
  return antigravityCommandOutlivesPrompt(toolCall);
}

/** A non-daemon command the agent awaits; unlike a schedule, it reports progress while it runs. */
export function antigravityCommandOutlivesPrompt(toolCall: AcpToolCallState): boolean {
  if (toolCall.title !== undefined && ANTIGRAVITY_SCHEDULE_TITLES.has(toolCall.title)) return false;
  const input = toolCall.data.rawInput;
  return toolCall.kind === "execute" && !(Predicate.isObject(input) && input.IsDaemon === true);
}

/** Native questions share the permission method, but their choices are not approvals. */
export function isAntigravityUserInputRequest(
  request: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  return request.toolCall.toolCallId.startsWith("interaction_");
}

/** Copy truncated text so V8 cannot retain the original large string. */
const SECURITY_WARNING_META_KEY = "agy.security.warning";
const WARNING_TEXT_LIMIT = 512;
const decodeSecurityWarning = Schema.decodeUnknownOption(
  Schema.Struct({
    title: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
);

/** Expose shell/web Allow Always _meta warnings as option text for both clients. */
function antigravitySecurityWarning(option: EffectAcpSchema.PermissionOption): string | undefined {
  const meta = option._meta;
  if (!Predicate.isObject(meta)) return undefined;
  const warning = Option.getOrUndefined(decodeSecurityWarning(meta[SECURITY_WARNING_META_KEY]));
  const text = warning?.message?.trim() || warning?.title?.trim();
  if (!text) return undefined;
  return text.length > WARNING_TEXT_LIMIT
    ? copyBoundedText(`${text.slice(0, WARNING_TEXT_LIMIT - 3)}...`)
    : text;
}

export function antigravityApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  if (isAntigravityUserInputRequest(request)) return [];
  const options: ProviderApprovalOption[] = [];
  const optionWithKind = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.find((entry) => entry.kind === kind && entry.optionId.trim());
  const once = optionWithKind("allow_once");
  if (once) {
    options.push({ decision: "accept", label: "Allow once" });
  }
  const always = optionWithKind("allow_always");
  if (always) {
    const warning = antigravitySecurityWarning(always);
    options.push({
      decision: "acceptForSession",
      label: "Allow for this thread",
      ...(warning ? { warning } : {}),
    });
  }
  if (optionWithKind("reject_once")) {
    options.push({ decision: "decline", label: "Deny" });
  }
  options.push({ decision: "cancel", label: "Cancel" });
  return options;
}

function copyBoundedText(text: string): string {
  return Buffer.from(text, "utf16le").toString("utf16le");
}

function boundQuestionText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 3).replace(/[\uD800-\uDBFF]$/u, "");
  return copyBoundedText(`${prefix}...`);
}

function questionLabel(option: EffectAcpSchema.PermissionOption): string {
  return boundQuestionText(option.name.trim() || option.optionId, QUESTION_LABEL_LIMIT);
}

export function extractAntigravityUserInputQuestion(
  request: EffectAcpSchema.RequestPermissionRequest,
): UserInputQuestion | undefined {
  if (!isAntigravityUserInputRequest(request) || request.options.length === 0) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const option of request.options) {
    if (!option.optionId.trim() || ids.has(option.optionId)) {
      return undefined;
    }
    ids.add(option.optionId);
  }
  const question = request.toolCall.title?.trim() || "Choose an option.";
  return {
    id: request.toolCall.toolCallId,
    header: "Question",
    question: boundQuestionText(question, TOOL_TEXT_LIMIT),
    multiSelect: false,
    allowCustomAnswer: false,
    options: request.options.map((option) => ({
      value: option.optionId,
      label: questionLabel(option),
      description: questionLabel(option),
    })),
  };
}

const isAskQuestionForm = Schema.is(
  Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
);
const isAskQuestionField = Schema.is(
  Schema.Struct({ title: Schema.String, description: Schema.optional(Schema.String) }),
);

/** agy's ask_question puts each question in its field's title and a count in the message. */
export const extractAntigravityElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isAskQuestionForm(request.requestedSchema)) return undefined;
  const form = parseElicitationForm(request.requestedSchema, request.message);
  if (form === undefined) return undefined;
  const { properties } = request.requestedSchema;
  return {
    questions: form.questions.map((question, index) => {
      const field = properties[question.id];
      if (!isAskQuestionField(field) || field.description?.trim() || !field.title.trim()) {
        return question;
      }
      return { ...question, header: `Question ${index + 1}`, question: field.title.trim() };
    }),
    respond: (answers) => {
      const content = form.content(answers);
      return content === undefined ? { action: "cancel" } : { action: "accept", content };
    },
  };
};

export function makeAntigravityUserInputResponse(
  request: EffectAcpSchema.RequestPermissionRequest,
  answers: ProviderUserInputAnswers,
): EffectAcpSchema.RequestPermissionResponse | undefined {
  if (extractAntigravityUserInputQuestion(request) === undefined) {
    return undefined;
  }
  const answer = Option.getOrUndefined(decodeSingleAnswer(answers[request.toolCall.toolCallId]));
  const value = typeof answer === "string" ? answer : answer?.[0];
  if (value === undefined) {
    return undefined;
  }
  const exact = request.options.find((option) => option.optionId === value);
  if (exact) {
    return { outcome: { outcome: "selected", optionId: exact.optionId } };
  }
  const matchingLabels = request.options.filter((option) => questionLabel(option) === value);
  const option = matchingLabels.length === 1 ? matchingLabels[0] : undefined;
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined;
}

function boundText(text: string, limit = TOOL_TEXT_LIMIT): string {
  return text.length <= limit
    ? text
    : copyBoundedText(`${TOOL_TEXT_TRUNCATED}${text.slice(-limit)}`);
}

function boundCommandText(text: string, limit = TOOL_TEXT_LIMIT): string {
  if (
    text.length <= limit ||
    (text.length <= limit + TOOL_TEXT_TRUNCATED.length && text.startsWith(TOOL_TEXT_TRUNCATED))
  ) {
    return text;
  }
  const tail = text.slice(-limit).replace(/^[\uDC00-\uDFFF]/u, "");
  return copyBoundedText(`${TOOL_TEXT_TRUNCATED}${tail}`);
}

// A command line's program and target are at its start, so it keeps its head.
function boundCommandLine(text: string, limit = TOOL_TEXT_LIMIT): string {
  if (
    text.length <= limit ||
    (text.length <= limit + COMMAND_LINE_TRUNCATED.length && text.endsWith(COMMAND_LINE_TRUNCATED))
  ) {
    return text;
  }
  const head = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
  return copyBoundedText(`${head}${COMMAND_LINE_TRUNCATED}`);
}

const COMMAND_LINE_FIELDS = new Set(["CommandLine", "command_line", "commandLine", "command"]);

const COMMAND_TEXT_FIELDS = new Set([
  "aggregatedOutput",
  "combinedOutput",
  "combined_output",
  "output",
  "text",
]);

/** Keeps the tail of long tool text, as every bounded tool payload does. */
export { boundText as boundAntigravityToolText };

/** True when bounding cut some of this text. */
export const isCutAntigravityToolText = (text: string) => text.includes(TOOL_TEXT_TRUNCATED);

interface ToolPayloadBudget {
  nodes: number;
  text: number;
}

function sanitizeToolValue(
  value: unknown,
  budget: ToolPayloadBudget,
  depth: number,
  field?: string,
): unknown {
  if (depth > 12 || budget.nodes-- <= 0) {
    return undefined;
  }
  if (typeof value === "string") {
    if (/^data:image\//i.test(value) || budget.text <= 0) {
      return undefined;
    }
    const bound =
      field === undefined
        ? boundText
        : COMMAND_LINE_FIELDS.has(field)
          ? boundCommandLine
          : COMMAND_TEXT_FIELDS.has(field)
            ? boundCommandText
            : boundText;
    const text = bound(value, Math.min(TOOL_TEXT_LIMIT, budget.text));
    budget.text -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value) {
      if (budget.nodes <= 0) break;
      const sanitized = sanitizeToolValue(entry, budget, depth + 1);
      if (sanitized !== undefined) result.push(sanitized);
    }
    return result;
  }
  if (!Predicate.isObject(value)) {
    return value;
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (budget.nodes <= 0) break;
    if (
      (value.type === "image" && (key === "data" || key === "blob")) ||
      (key === "blob" &&
        typeof value.mimeType === "string" &&
        value.mimeType.startsWith("image/")) ||
      ((key === "formatted_output" || key === "formattedOutput") &&
        (entry === value.combinedOutput || entry === value.combined_output))
    ) {
      continue;
    }
    const sanitized = sanitizeToolValue(entry, budget, depth + 1, key);
    if (sanitized !== undefined) entries.push([key, sanitized]);
  }
  return Object.fromEntries(entries);
}

export function sanitizeAntigravityToolPayload(payload: unknown): unknown {
  return sanitizeToolValue(payload, { nodes: 512, text: 64_000 }, 0);
}
const isJsonRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

const ANTIGRAVITY_CLIENT_READ_TITLES = new Set([
  "Running client_view_file",
  "Run client_view_file?",
]);

function antigravityClientReadPath(update: {
  readonly title?: string | null;
  readonly locations?: ReadonlyArray<{ readonly path: string }> | null;
  readonly rawInput?: unknown;
}): string | undefined {
  if (!update.title || !ANTIGRAVITY_CLIENT_READ_TITLES.has(update.title)) return undefined;
  const target =
    update.locations?.[0]?.path ??
    (Predicate.isObject(update.rawInput) ? update.rawInput.absolute_path : undefined);
  return typeof target === "string" && target ? target : undefined;
}

/**
 * The agent never completes a subagent's `client_view_file` call, then fails every open call
 * with the next unrelated step error. Report reads T3 served as completed instead.
 */
export function makeAntigravityReadRepair() {
  type Outcome = "served" | "refused";
  const openReads = new Map<
    string,
    { readonly path: string; readonly sessionId: string; outcome?: Outcome }
  >();
  // The agent runs a client tool in a background task, so its request can precede the announcement.
  const earlyOutcomes: Array<{ readonly path: string; readonly outcome: Outcome }> = [];
  return {
    /** Earlier turns' rows are already settled, and their unanswered reads must not take credit. */
    reset: () => {
      openReads.clear();
      earlyOutcomes.length = 0;
    },
    /**
     * Each `fs/read_text_file` request answers the oldest open read of its path, in order.
     * Returns the call a served read completes, so T3 can report it without waiting.
     */
    attempted: (path: string, served: boolean) => {
      const outcome = served ? "served" : "refused";
      for (const [toolCallId, read] of openReads) {
        if (read.path !== path || read.outcome !== undefined) continue;
        read.outcome = outcome;
        return served ? { sessionId: read.sessionId, toolCallId } : undefined;
      }
      earlyOutcomes.push({ path, outcome });
      return undefined;
    },
    repair: (
      notification: EffectAcpSchema.SessionNotification,
    ): EffectAcpSchema.SessionNotification => {
      const update = notification.update;
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        return notification;
      }
      const path = antigravityClientReadPath(update);
      if (path !== undefined && !openReads.has(update.toolCallId)) {
        const early = earlyOutcomes.findIndex((entry) => entry.path === path);
        const outcome = early === -1 ? undefined : earlyOutcomes.splice(early, 1)[0]?.outcome;
        const sessionId = notification.sessionId;
        openReads.set(
          update.toolCallId,
          outcome === undefined ? { path, sessionId } : { path, sessionId, outcome },
        );
      }
      const read = openReads.get(update.toolCallId);
      if (update.status === "pending" || update.status === "in_progress") {
        return read?.outcome === "served"
          ? { ...notification, update: { ...update, status: "completed" } }
          : notification;
      }
      if (update.status !== "completed" && update.status !== "failed") return notification;
      openReads.delete(update.toolCallId);
      if (update.status === "completed" || read?.outcome !== "served") return notification;
      const { rawOutput: _stepError, ...rest } = update;
      return { ...notification, update: { ...rest, status: "completed" } };
    },
  };
}

function stripAntigravityToolSummary(value: unknown): unknown {
  if (!Predicate.isObject(value) || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  let next: Record<string, unknown> = record;
  if ("toolSummary" in next) {
    const { toolSummary: _toolSummary, ...rest } = next;
    next = rest;
  }
  if (Predicate.isObject(next.Arguments) && "toolSummary" in next.Arguments) {
    const { toolSummary: _toolSummary, ...args } = next.Arguments;
    next = { ...next, Arguments: args };
  }
  return next;
}

/**
 * agy adds its own `toolSummary` to MCP call arguments. T3 records its MCP results under the
 * arguments it received, so the summary is dropped before the shared adapter matches them.
 * Untitled updates cannot be identified and are stripped too; titled non-T3 calls keep it.
 */
function withoutT3McpToolSummary(
  update: Extract<
    EffectAcpSchema.SessionNotification["update"],
    { readonly sessionUpdate: "tool_call" | "tool_call_update" }
  >,
): unknown {
  const rawInput = update.rawInput;
  if (!Predicate.isObject(rawInput) || Array.isArray(rawInput)) return rawInput;
  if (typeof update.title === "string") {
    const identity = extractMcpToolCallIdentity({
      toolCallId: update.toolCallId,
      title: update.title,
      data: {
        title: update.title,
        rawInput,
        ...(Predicate.isObject(update._meta) ? { meta: update._meta } : {}),
      },
    });
    if (
      identity === undefined ||
      resolveT3McpToolId(`${identity.server}.${identity.tool}`) === null
    ) {
      return rawInput;
    }
  }
  return stripAntigravityToolSummary(rawInput);
}

/** Stands in for a content entry the size limits removed or cut, so its paths read as unknown. */
const UNREAD_TOOL_CONTENT = { type: "_t3_unknown", originalType: "unread", raw: null } as const;

function namesSamePaths(
  sent: { readonly content: ReadonlyArray<unknown> },
  kept: { readonly content: ReadonlyArray<unknown> },
): boolean {
  const sentPaths = acpChangedPathsOfToolCall(sent);
  const keptPaths = acpChangedPathsOfToolCall(kept);
  if (sentPaths === "unknown" || keptPaths === "unknown") return sentPaths === keptPaths;
  return (
    sentPaths.length === keptPaths.length &&
    sentPaths.every((path, index) => path === keptPaths[index])
  );
}

/** The bounded raw input with each path the agent sent put back, or blanked when it is too long. */
function withSentRawInputPaths(sent: unknown, bounded: unknown): unknown {
  if (!Predicate.isObject(sent) || !Predicate.isObject(bounded)) return bounded;
  const paths: Record<string, string> = {};
  for (const key of ACP_RAW_INPUT_PATH_KEYS) {
    const path = sent[key];
    if (path === undefined || path === null || path === bounded[key]) continue;
    paths[key] = typeof path === "string" && path.length <= TOOL_TEXT_LIMIT ? path : "";
  }
  return { ...bounded, ...paths };
}

export function normalizeAntigravitySessionUpdate(
  notification: EffectAcpSchema.SessionNotification,
): EffectAcpSchema.SessionNotification {
  const update = notification.update;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return notification;
  }
  const contentBudget = { nodes: 512, text: 32_000 };
  const content = update.content?.flatMap((entry) => {
    const decoded = Option.getOrUndefined(
      decodeToolCallContent(sanitizeToolValue(entry, contentBudget, 0)),
    );
    const kept = decoded === undefined ? [] : [decoded];
    // The size limits may drop an entry or cut its path; what is left is not the whole change.
    return namesSamePaths({ content: [entry] }, { content: kept })
      ? kept
      : [...kept, UNREAD_TOOL_CONTENT];
  });
  const meta = sanitizeAntigravityToolPayload(update._meta);
  return {
    ...notification,
    update: {
      ...update,
      ...(typeof update.title === "string" ? { title: boundText(update.title) } : {}),
      ...(update.rawInput !== undefined
        ? {
            rawInput: withSentRawInputPaths(
              update.rawInput,
              sanitizeAntigravityToolPayload(withoutT3McpToolSummary(update)),
            ),
          }
        : {}),
      ...(update.rawOutput !== undefined
        ? { rawOutput: sanitizeAntigravityToolPayload(update.rawOutput) }
        : {}),
      ...(update.content !== undefined ? { content: content ?? [] } : {}),
      ...(update._meta !== undefined ? { _meta: isJsonRecord(meta) ? meta : null } : {}),
    },
  };
}

function antigravityUpdateSteps(
  rawInput: unknown,
):
  | Extract<EffectAcpSchema.SessionUpdate, { readonly sessionUpdate: "plan" }>["entries"]
  | undefined {
  if (!Predicate.isObject(rawInput) || !Array.isArray(rawInput.steps)) return undefined;
  const steps: ReadonlyArray<unknown> = rawInput.steps;
  return steps.flatMap((step) =>
    Predicate.isObject(step) && typeof step.title === "string"
      ? [
          {
            content: step.title,
            priority: "medium",
            status:
              step.status === "done"
                ? "completed"
                : typeof step.status === "string"
                  ? step.status
                  : "pending",
          },
        ]
      : [],
  );
}

/**
 * agy reports its update_steps checklist only as tool calls, never as ACP `plan` updates. Each
 * call carrying steps becomes a plan update; its other updates name it by id only and are dropped.
 */
export function makeAntigravityUpdateStepsPlans() {
  const calls = new Set<string>();
  return (
    notification: EffectAcpSchema.SessionNotification,
  ): EffectAcpSchema.SessionNotification | undefined => {
    const update = notification.update;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return notification;
    }
    const key = `${notification.sessionId}\u0000${update.toolCallId}`;
    if (
      update.title === "Run update_steps" &&
      (update.kind === undefined || update.kind === null || update.kind === "other")
    ) {
      calls.add(key);
    }
    if (!calls.has(key)) return notification;
    if (update.status === "completed" || update.status === "failed") calls.delete(key);
    const entries = antigravityUpdateSteps(update.rawInput);
    return entries === undefined
      ? undefined
      : { ...notification, update: { sessionUpdate: "plan", entries } };
  };
}

function localImagePath(imagePath: string | undefined): string | undefined {
  if (!imagePath || imagePath.length > TOOL_TEXT_LIMIT) {
    return undefined;
  }
  const path = imagePath.trim();
  if (!isWorkspaceImagePreviewPath(path)) {
    return undefined;
  }
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return undefined;
      const pathname = decodeURIComponent(url.pathname);
      return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return undefined;
    }
  }
  return /^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) ? undefined : path;
}

function hasTruncatedText(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith(TOOL_TEXT_TRUNCATED);
  return Predicate.isObject(value) && Object.values(value).some(hasTruncatedText);
}

/** The ACP adapter renders a diff's `patch.text` ahead of its bare old/new snippets. */
function withAntigravityEditPatches(
  content: ReadonlyArray<unknown>,
  data: Record<string, unknown>,
  readPreEditFile: ((path: string) => string | undefined) | undefined,
) {
  return content.map((entry) => {
    if (!Predicate.isObject(entry) || entry.type !== "diff" || typeof entry.path !== "string")
      return entry;
    // Keep the first patch: once the edit runs, the file no longer holds the old text. A later
    // update's shared text budget can cut or drop it, and a cut patch would misplace the hunk.
    if (entry.patch !== undefined) {
      const patch: unknown = entry.patch;
      const cut =
        Predicate.isObject(patch) &&
        patch.format !== "omitted" &&
        (typeof patch.text !== "string" || patch.text.startsWith(TOOL_TEXT_TRUNCATED));
      return cut ? { ...entry, patch: { format: "omitted" } } : entry;
    }
    // Bounding keeps only the tail of long text, so a cut snippet cannot be located and a cut
    // old or new text would render the cut as file content.
    if ([data.rawInput, entry.oldText, entry.newText].some(hasTruncatedText))
      return { ...entry, patch: { format: "omitted" } };
    const text = antigravityEditPatch({
      path: entry.path,
      rawInput: data.rawInput,
      locations: data.locations,
      readPreEditFile,
    });
    // A truncated patch would no longer parse, and bare snippets would render at line 1.
    if (
      text === ANTIGRAVITY_EDIT_DIFF_OMITTED ||
      (text !== undefined && text.length > TOOL_TEXT_LIMIT)
    )
      return { ...entry, patch: { format: "omitted" } };
    if (text === undefined) return entry;
    return {
      ...entry,
      patch: isAntigravitySnippetPatch(text) ? { format: "snippet", text } : { text },
    };
  });
}

export function normalizeAntigravityToolCall(
  toolCall: AcpToolCallState,
  readPreEditFile = readAntigravityPreEditFile,
): AcpToolCallState {
  const input = Option.getOrUndefined(decodeNativeToolFields(toolCall.data.rawInput));
  const output = Option.getOrUndefined(decodeNativeToolFields(toolCall.data.rawOutput));
  const nativeCommand =
    input?.CommandLine ??
    input?.command_line ??
    input?.commandLine ??
    input?.command ??
    output?.commandLine ??
    output?.command_line ??
    toolCall.command;
  const command = nativeCommand?.trim() ? boundCommandLine(nativeCommand.trim()) : undefined;
  const nativeCwd =
    input?.Cwd ??
    input?.WorkingDirectory ??
    input?.working_dir ??
    input?.workingDir ??
    input?.cwd ??
    output?.workingDir ??
    output?.working_dir;
  const cwd = nativeCwd?.trim() ? boundText(nativeCwd.trim()) : undefined;
  const nativeOutput = output?.combinedOutput ?? output?.combined_output;
  const aggregatedOutput = nativeOutput === undefined ? undefined : boundCommandText(nativeOutput);
  const exitCode = output?.exitCode ?? output?.exit_code;
  const imagePath = localImagePath(output?.imagePath);
  const sanitizedData = sanitizeAntigravityToolPayload(toolCall.data);
  const data: Record<string, unknown> = Predicate.isObject(sanitizedData) ? sanitizedData : {};
  const kind = toolCall.kind ?? (command !== undefined ? "execute" : undefined);
  if (kind !== undefined) data.kind = kind;
  if (command !== undefined) data.command = command;
  if (cwd !== undefined) data.cwd = cwd;
  if (imagePath !== undefined) data.imagePath = imagePath;
  if (kind === "edit") {
    const content = Array.isArray(data.content) ? data.content : [];
    // Full-access edits report only a path; without a hunk the checkpoint diff is the review.
    data.content = content.some((entry) => Predicate.isObject(entry) && entry.type === "diff")
      ? withAntigravityEditPatches(
          content,
          data,
          toolCall.status === "pending" ? readPreEditFile : undefined,
        )
      : [...content, { type: "diff", patch: { format: "omitted" } }];
  }
  if (kind === "execute") {
    data.item = {
      ...(Predicate.isObject(data.item) ? data.item : {}),
      ...(command !== undefined ? { command } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(aggregatedOutput !== undefined ? { aggregatedOutput } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }
  const normalized: AcpToolCallState = {
    ...toolCall,
    ...(kind !== undefined ? { kind } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(toolCall.title !== undefined ? { title: boundText(toolCall.title) } : {}),
    ...(command !== undefined
      ? { detail: command }
      : toolCall.detail !== undefined
        ? { detail: boundText(toolCall.detail) }
        : {}),
    data,
  };
  return normalizeAntigravitySwarmToolPresentation(normalized);
}

const ANTIGRAVITY_SUBAGENT_TITLES = new Set([
  "Running start_subagent",
  "Run start_subagent?",
  "Running invoke_subagent",
  "Run invoke_subagent?",
  // agy 1.5 auto-approved calls.
  "Run invoke_subagent",
]);

const ANTIGRAVITY_SWARM_TOOLS = new Set([
  "swarm",
  "post_message",
  "read_board",
  "swarm_wait",
] as const);

export type AntigravitySwarmToolName = "swarm" | "post_message" | "read_board" | "swarm_wait";

const LEGACY_SWARM_TITLE_TO_TOOL = new Map<string, AntigravitySwarmToolName>([
  ["Running swarm", "swarm"],
  ["Run swarm?", "swarm"],
  ["Run swarm", "swarm"],
  ["Running post_message", "post_message"],
  ["Run post_message?", "post_message"],
  ["Run post_message", "post_message"],
  ["Running read_board", "read_board"],
  ["Run read_board?", "read_board"],
  ["Run read_board", "read_board"],
  ["Running swarm_wait", "swarm_wait"],
  ["Run swarm_wait?", "swarm_wait"],
  ["Run swarm_wait", "swarm_wait"],
]);

function readToolMeta(toolCall: AcpToolCallState, rawPayload?: unknown): unknown {
  const update = Predicate.isObject(rawPayload) ? rawPayload.update : undefined;
  if (Predicate.isObject(update) && update._meta !== undefined) return update._meta;
  return toolCall.data.meta ?? toolCall.data._meta;
}

function isSwarmToolName(value: unknown): value is AntigravitySwarmToolName {
  return (
    typeof value === "string" && ANTIGRAVITY_SWARM_TOOLS.has(value as AntigravitySwarmToolName)
  );
}

function identifyAntigravitySwarmToolCall(
  toolCall: AcpToolCallState,
  rawPayload?: unknown,
):
  | {
      readonly tool: AntigravitySwarmToolName;
      readonly action?: string | undefined;
      readonly mcp: boolean;
    }
  | undefined {
  const meta = readToolMeta(toolCall, rawPayload);
  const mcp = Predicate.isObject(meta) && meta.is_mcp_tool_call === true;
  const antigravity = Predicate.isObject(meta) ? meta.antigravity : undefined;
  const swarmMeta = Predicate.isObject(antigravity) ? antigravity.swarm : undefined;
  const metaTool = Predicate.isObject(swarmMeta) ? swarmMeta.tool : undefined;
  const tool = isSwarmToolName(metaTool)
    ? metaTool
    : toolCall.title === undefined
      ? undefined
      : LEGACY_SWARM_TITLE_TO_TOOL.get(toolCall.title.trim());
  if (tool === undefined) return undefined;
  if (
    (tool === "swarm" || tool === "post_message") &&
    toolCall.kind !== undefined &&
    toolCall.kind !== "other"
  ) {
    return undefined;
  }
  if (
    tool === "read_board" &&
    toolCall.kind !== undefined &&
    toolCall.kind !== "other" &&
    toolCall.kind !== "read"
  ) {
    return undefined;
  }
  if (
    tool === "swarm_wait" &&
    toolCall.kind !== undefined &&
    toolCall.kind !== "other" &&
    toolCall.kind !== "think"
  ) {
    return undefined;
  }
  const metaAction =
    Predicate.isObject(swarmMeta) && typeof swarmMeta.action === "string"
      ? swarmMeta.action.trim()
      : undefined;
  const rawInput = toolCall.data.rawInput;
  const inputAction =
    Predicate.isObject(rawInput) && typeof rawInput.action === "string"
      ? rawInput.action.trim()
      : undefined;
  const action = metaAction || inputAction;
  return { tool, ...(action === undefined ? {} : { action }), mcp };
}

function formatSwarmToolPresentation(
  tool: AntigravitySwarmToolName,
  action: string | undefined,
  rawInput: unknown,
): { readonly kind: NonNullable<AcpToolCallState["kind"]>; readonly title: string } {
  const input = Predicate.isObject(rawInput) ? rawInput : undefined;
  const cleanHandle = (value: unknown) =>
    typeof value === "string" ? value.trim().replace(/^@/, "") : "";
  const cleanChannel = (value: unknown) =>
    typeof value === "string" ? value.trim().replace(/^#/, "") : "";

  switch (tool) {
    case "swarm": {
      const name = cleanHandle(input?.name);
      switch (action?.toLowerCase()) {
        case "add": {
          const tasks = Array.isArray(input?.tasks) ? input.tasks.length : 0;
          const n =
            typeof input?.n === "number" && Number.isFinite(input.n) ? Math.trunc(input.n) : 0;
          const count = Math.max(tasks, n);
          if (count > 1 && name.length > 0) {
            return { kind: "other", title: `Add ${count} swarm workers (@${name}-1..${count})` };
          }
          if (count > 1) return { kind: "other", title: `Add ${count} swarm workers` };
          return {
            kind: "other",
            title: name.length > 0 ? `Add swarm worker @${name}` : "Add swarm worker",
          };
        }
        case "kill":
          return {
            kind: "other",
            title: name.length > 0 ? `Stop swarm worker @${name}` : "Stop swarm worker",
          };
        case "status":
          return { kind: "other", title: "Check swarm status" };
        case "models":
          return { kind: "other", title: "List swarm models" };
        case "model": {
          const model = typeof input?.model === "string" ? input.model.trim() : "";
          if (name.length > 0 && model.length > 0) {
            return { kind: "other", title: `Switch @${name} model to ${model}` };
          }
          if (name.length > 0) return { kind: "other", title: `Switch swarm model for @${name}` };
          if (model.length > 0) return { kind: "other", title: `Switch swarm model to ${model}` };
          return { kind: "other", title: "Switch swarm model" };
        }
        case "title": {
          const title = typeof input?.title === "string" ? input.title.trim() : "";
          return {
            kind: "other",
            title: title.length > 0 ? `Set swarm title "${title}"` : "Set swarm title",
          };
        }
        case "channel": {
          const op = typeof input?.op === "string" ? input.op.trim() : "";
          const channel = cleanChannel(input?.channel);
          if (op.length > 0 && channel.length > 0) {
            return { kind: "other", title: `Swarm channel ${op} #${channel}` };
          }
          return {
            kind: "other",
            title: op.length > 0 ? `Swarm channel ${op}` : "Manage swarm channels",
          };
        }
        case "join": {
          const swarm = typeof input?.swarm === "string" ? input.swarm.trim() : "";
          return {
            kind: "other",
            title: swarm.length > 0 ? `Join swarm ${swarm}` : "Join swarm",
          };
        }
        default:
          return { kind: "other", title: "Run swarm" };
      }
    }
    case "post_message": {
      const channel = cleanChannel(input?.channel);
      return {
        kind: "other",
        title:
          channel.length > 0 && channel !== "main" ? `Post to #${channel}` : "Post to swarm board",
      };
    }
    case "read_board": {
      if (input?.status === true) return { kind: "other", title: "Read swarm status" };
      const channel = cleanChannel(input?.channel);
      return {
        kind: "other",
        title:
          channel.length > 0 && channel !== "main" && channel !== "*"
            ? `Read #${channel}`
            : "Read swarm board",
      };
    }
    case "swarm_wait":
      return { kind: "think", title: "Wait for swarm board" };
  }
}

function normalizeAntigravitySwarmToolPresentation(toolCall: AcpToolCallState): AcpToolCallState {
  const swarm = identifyAntigravitySwarmToolCall(toolCall);
  if (swarm === undefined || swarm.mcp) return toolCall;
  const legacyTool =
    toolCall.title === undefined
      ? undefined
      : LEGACY_SWARM_TITLE_TO_TOOL.get(toolCall.title.trim());
  if (legacyTool === undefined) return toolCall;
  const presentation = formatSwarmToolPresentation(
    swarm.tool,
    swarm.action,
    toolCall.data.rawInput,
  );
  const existingMeta = Predicate.isObject(toolCall.data.meta) ? toolCall.data.meta : {};
  const existingAntigravity = Predicate.isObject(existingMeta.antigravity)
    ? existingMeta.antigravity
    : {};
  return {
    ...toolCall,
    kind: presentation.kind,
    title: boundText(presentation.title),
    data: {
      ...toolCall.data,
      meta: {
        ...existingMeta,
        antigravity: {
          ...existingAntigravity,
          swarm: {
            tool: swarm.tool,
            ...(swarm.action === undefined ? {} : { action: swarm.action }),
          },
        },
      },
    },
  };
}

export function antigravitySwarmAddChildSessionId(toolCall: AcpToolCallState): string | null {
  const output = toolCall.data.rawOutput;
  if (!Predicate.isObject(output) || typeof output.conversation_id !== "string") return null;
  const id = output.conversation_id.trim();
  return id.length > 0 ? id : null;
}

export function antigravitySwarmAddModel(toolCall: AcpToolCallState): string | null {
  const output = toolCall.data.rawOutput;
  if (Predicate.isObject(output) && typeof output.model === "string" && output.model.trim()) {
    return output.model.trim();
  }
  const input = toolCall.data.rawInput;
  if (Predicate.isObject(input) && typeof input.model === "string" && input.model.trim()) {
    return input.model.trim();
  }
  return null;
}

/** Classifies native Antigravity subagent and `swarm` worker launch tool calls. */
export function classifyAntigravitySubagentToolCall(
  toolCall: AcpToolCallState,
  rawPayload?: unknown,
): "subagent" | "mcp" | undefined {
  if (toolCall.kind !== undefined && toolCall.kind !== "other") return undefined;
  const swarm = identifyAntigravitySwarmToolCall(toolCall, rawPayload);
  if (swarm !== undefined) {
    if (swarm.tool !== "swarm") return undefined;
    if (swarm.mcp) return "mcp";
    return swarm.action?.toLowerCase() === "add" ? "subagent" : undefined;
  }
  if (toolCall.title === undefined || !ANTIGRAVITY_SUBAGENT_TITLES.has(toolCall.title)) {
    return undefined;
  }
  const meta = readToolMeta(toolCall, rawPayload);
  return Predicate.isObject(meta) && meta.is_mcp_tool_call === true ? "mcp" : "subagent";
}

export function antigravitySubagentOutput(toolCall: AcpToolCallState): string | undefined {
  const output = toolCall.data.rawOutput;
  return typeof output === "string" && output.trim() ? boundText(output.trim()) : undefined;
}
