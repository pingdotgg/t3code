import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous UUID needs no Crypto service in every test layer.
import * as NodeCrypto from "node:crypto";

import {
  AgentSessionScanError,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type AgentSessionImportInput,
  type AgentSessionHistoryInput,
  type AgentSessionHistoryResult,
  AgentSessionPreviewInput,
  AgentSessionPreviewResult,
  type AgentSessionImportSource,
  type AgentSessionProjectCandidate,
  type AgentSessionProjectGit,
  type AgentSessionScanResult,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { isBareGitConfig, parseOriginUrlFromGitConfig } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { repositoryPathFromRemoteUrl } from "@t3tools/source-control-core/server/SourceControlProvider";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { resolvePiSessionsDir } from "@t3tools/provider-pi/server/usage";
import * as ServerSettings from "../serverSettings.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import {
  createTranscriptJsonReader,
  createTranscriptJsonSelector,
  TranscriptJsonLimitError,
} from "./AgentSessionJson.ts";
import {
  createSessionDiscovery,
  readDiscoveryDirectory,
  type DiscoveryHome,
  type DiscoveryFile,
} from "./AgentSessionDiscovery.ts";
import { createPreviewIndex } from "./AgentSessionPreviewIndex.ts";

const TRANSCRIPT_PREFIX_BYTES = 32 * 1024;
const METADATA_READ_BYTES = 8 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 1024 * 1024;
const MAX_CODEX_SESSION_INDEX_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const MAX_TRANSCRIPTS_PER_SOURCE = 5000;

const MAX_DISCOVERY_OPERATIONS_PER_SOURCE = MAX_TRANSCRIPTS_PER_SOURCE * 4;
const MAX_METADATA_BYTES_PER_SOURCE = 64 * 1024 * 1024;
const MAX_METADATA_OPERATIONS_PER_SOURCE = MAX_TRANSCRIPTS_PER_SOURCE * 4;
const MAX_METADATA_RECORDS_PER_SOURCE = 100_000;
const MAX_METADATA_RECORDS_PER_TRANSCRIPT = 1_000;
const RECENT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Screenshot-heavy transcripts can reach GiB; select fields while streaming to avoid allocating payloads.
const MAX_IMPORTED_TRANSCRIPT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_IMPORTED_MESSAGES = 200;
const MAX_IMPORT_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_IMPORT_TRANSCRIPTS = 100;
const MAX_IMPORT_RECORDS = 100_000;

/**
 * open() of a file under macOS privacy protection waits on a consent prompt
 * that a headless server never gets, and a FIFO waits for a writer. Either
 * pins a libuv pool thread that interruption cannot free, so git files of
 * arbitrary transcript cwds are read by a `cat` child we can kill instead.
 */
const GIT_FILE_READ_DEADLINE = "2 seconds";
const MAX_GIT_FILE_BYTES = 1024 * 1024;
// Reads run concurrently, so each phase waits one deadline per batch of this
// many blocked files rather than one per blocked file.
const GIT_FILE_READ_CONCURRENCY = 16;
// A blocked path is skipped for a while, then read again in case it was fixed.
const BLOCKED_GIT_FILE_RETRY_MS = 5 * 60 * 1000;
const MAX_BLOCKED_GIT_FILE_PATHS = 1024;

const TranscriptContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

const TranscriptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TranscriptContentBlock)])),
  model: Schema.optional(Schema.String),
});

const CodexTurnMetadata = Schema.Struct({
  turn_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  // Pi entries form a tree through id/parentId; session_info entries carry its name.
  id: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  aiTitle: Schema.optional(Schema.String),
  customTitle: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(TranscriptMessage),
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      session_id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Array(TranscriptContentBlock)),
      internal_chat_message_metadata_passthrough: Schema.optional(Schema.Unknown),
    }),
  ),
});

const CodexSessionIndexEntry = Schema.Struct({
  id: Schema.String,
  thread_name: Schema.String,
});

const encodeDiscoveryHomes = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isScanError = Schema.is(AgentSessionScanError);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeTranscriptRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));
const decodeTranscriptValue = Schema.decodeUnknownOption(TranscriptRecord);
const decodePiEntryLinks = Schema.decodeUnknownOption(
  Schema.Struct({
    type: TranscriptRecord.fields.type,
    id: TranscriptRecord.fields.id,
    parentId: TranscriptRecord.fields.parentId,
  }),
);
const selectTranscriptPath = createTranscriptJsonSelector(TranscriptRecord);
const decodeCodexTurnMetadata = Schema.decodeUnknownOption(CodexTurnMetadata);
const decodeCodexSessionIndexEntry = Schema.decodeUnknownOption(
  Schema.fromJsonString(CodexSessionIndexEntry),
);

type DecodedTranscriptRecord = typeof TranscriptRecord.Type & { readonly sourceOffset?: number };

interface AgentSessionTranscriptMetadata {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly fallbackSessionId: string;
  readonly lastActiveAtMs: number;
}

export interface AgentSessionThreadMessage {
  readonly sourceOffset?: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface AgentSessionThread {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<AgentSessionThreadMessage>;
  readonly omittedMessageCount: number;
}

export type AgentSessionRecentThread =
  | {
      readonly _tag: "Importable";
      readonly thread: AgentSessionThread;
      readonly source: AgentSessionImportSource;
      readonly olderByteOffset?: number;
      readonly previewResult?: AgentSessionPreviewResult;
    }
  | { readonly _tag: "AlreadyImported"; readonly source: AgentSessionImportSource }
  | { readonly _tag: "Duplicate"; readonly source: AgentSessionImportSource }
  | { readonly _tag: "Skipped" };

export class AgentSessionScanner extends Context.Service<
  AgentSessionScanner,
  {
    readonly scan: Effect.Effect<AgentSessionScanResult, AgentSessionScanError>;
    readonly previewSession: (
      input: AgentSessionPreviewInput,
    ) => Effect.Effect<AgentSessionPreviewResult, AgentSessionScanError>;
    readonly listSessions: (
      input: AgentSessionHistoryInput,
      cachedContext?: ReadonlyMap<string, Extract<AgentSessionPreviewResult, { status: "ready" }>>,
    ) => Effect.Effect<AgentSessionHistoryResult, AgentSessionScanError>;
    readonly recentThreads: (
      workspaceRoot: string,
      completedSources?: ReadonlyArray<AgentSessionImportSource>,
      session?: AgentSessionImportInput["session"],
    ) => Stream.Stream<AgentSessionRecentThread, AgentSessionScanError>;
  }
>()("t3/project/AgentSessionScanner") {}

type AgentSessionSource = AgentSessionProjectCandidate["sources"][number];

interface RawCandidate {
  readonly cwd: string;
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly homePath: string;
  readonly threadCount: number;
  readonly lastActiveAtMs: number | null;
  readonly transcripts: ReadonlyArray<{
    readonly filePath: string;
    readonly mtimeMs: number | null;
    readonly providerSessionId: string;
    readonly title: string | undefined;
    readonly discovered?: {
      readonly identity: TranscriptIdentity;
      readonly record: DecodedTranscriptRecord;
    };
  }>;
}

interface TranscriptCandidate {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly homePath: string;
  readonly size: number;
}

interface MetadataReadBudget {
  bytesRemaining: number;
  operationsRemaining: number;
  recordsRemaining: number;
  truncated: boolean;
}

function selectMetadataTranscripts(transcripts: ReadonlyArray<TranscriptCandidate>) {
  const selected: Array<TranscriptCandidate> = [];
  let pending = Array.from(
    Map.groupBy(transcripts, (transcript) => transcript.providerInstanceId).values(),
    (entries) => entries.values(),
  );
  while (pending.length > 0 && selected.length < MAX_TRANSCRIPTS_PER_SOURCE) {
    const nextRound: typeof pending = [];
    for (const iterator of pending) {
      if (selected.length === MAX_TRANSCRIPTS_PER_SOURCE) break;
      const next = iterator.next();
      if (next.done) continue;
      selected.push(next.value);
      nextRound.push(iterator);
    }
    pending = nextRound;
  }
  return selected;
}

function splitTranscriptRecords(contents: string, limit: number): string[] {
  const records = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return records.split("\n", limit);
}

function isTextContentBlock(block: typeof TranscriptContentBlock.Type): boolean {
  return block.type === "text" || block.type === "input_text" || block.type === "output_text";
}

function extractText(
  content: string | ReadonlyArray<typeof TranscriptContentBlock.Type> | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (content === undefined) return "";
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : fallback;
}

function codexTurnId(metadata: unknown): string | null {
  const decoded = decodeCodexTurnMetadata(metadata);
  if (
    Option.isNone(decoded) ||
    typeof decoded.value.turn_id !== "string" ||
    decoded.value.turn_id.trim().length === 0
  ) {
    return null;
  }
  return decoded.value.turn_id;
}

function isHiddenClaudeRecord(record: DecodedTranscriptRecord): boolean {
  return record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true;
}

// Claude repeats session fields on records that need not be retained.
interface ClaudeFields {
  readonly sessionId: string | undefined;
  readonly title: string | undefined;
  readonly customTitle: string | null;
  readonly model: string | undefined;
}

const emptyClaudeFields: ClaudeFields = {
  sessionId: undefined,
  title: undefined,
  customTitle: null,
  model: undefined,
};

function foldClaudeFields(fields: ClaudeFields, record: DecodedTranscriptRecord): ClaudeFields {
  if (isHiddenClaudeRecord(record)) return fields;
  const model = record.message?.model?.trim();
  return {
    sessionId: record.sessionId?.trim() || fields.sessionId,
    title: record.aiTitle?.trim() || fields.title,
    // Claude flushes the AI title after the user's rename; an empty rename clears it.
    customTitle:
      record.customTitle === undefined ? fields.customTitle : record.customTitle.trim() || null,
    // Claude uses this sentinel for local error responses. It is not a
    // model ID that can be selected when the imported session resumes.
    model: model && model !== "<synthetic>" ? model : fields.model,
  };
}

// Codex records setup context as user text ahead of the real request. Skip
// these leading blocks when deriving a title; imported messages keep them.
const CODEX_TITLE_PREAMBLE =
  /^(?:\s*(?:<(recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|in-app-browser-context)(?:\s[^>]*)?>[\s\S]*?<\/\1>|# AGENTS\.md instructions\b[^\n]*|## My request for Codex:))+/;

// Codex appends an entry per rename; like Codex, the newest nonempty name wins.
function parseCodexThreadNames(contents: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const entry = Option.getOrUndefined(decodeCodexSessionIndexEntry(line));
    const name = entry?.thread_name.trim();
    if (entry !== undefined && name) names.set(entry.id, name);
  }
  return names;
}

function deriveTitle(source: AgentSessionSource, text: string): string | undefined {
  const request = source === "codex" ? text.replace(CODEX_TITLE_PREAMBLE, "") : text;
  return request.trim().split("\n")[0]?.slice(0, 100).trim() || undefined;
}

// Pi keeps abandoned branches in the file; its active branch runs from the last entry to the root.
function activePiBranch(
  records: ReadonlyArray<DecodedTranscriptRecord>,
): ReadonlyArray<DecodedTranscriptRecord> {
  const entries = records.filter((record) => record.type !== "session");
  const leaf = entries.at(-1);
  // Version 1 sessions predate the tree and are linear.
  if (leaf?.id === undefined) return entries;
  const byId = new Map(
    entries.flatMap((entry) => (entry.id === undefined ? [] : [[entry.id, entry] as const])),
  );
  const branch: Array<DecodedTranscriptRecord> = [];
  for (
    let entry: DecodedTranscriptRecord | undefined = leaf;
    entry !== undefined && branch.length < entries.length;
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  ) {
    branch.push(entry);
  }
  return branch.toReversed();
}

function isPiConversationRecord(
  record: DecodedTranscriptRecord,
): record is DecodedTranscriptRecord & {
  readonly message: typeof TranscriptMessage.Type & { readonly role: "user" | "assistant" };
} {
  return (
    record.type === "message" &&
    (record.message?.role === "user" || record.message?.role === "assistant")
  );
}

export function parseAgentSessionTranscript(
  input: AgentSessionTranscriptMetadata & {
    readonly contents: string;
  },
  lines = splitTranscriptRecords(input.contents, MAX_IMPORT_RECORDS + 1),
): AgentSessionThread | null {
  if (lines.length > MAX_IMPORT_RECORDS) return null;
  const records = lines.flatMap((line) => Option.toArray(decodeTranscriptRecord(line)));
  const claudeFields =
    input.source === "claudeAgent"
      ? records.reduce(foldClaudeFields, emptyClaudeFields)
      : emptyClaudeFields;
  return parseAgentSessionRecords(input, records, claudeFields);
}

function parseAgentSessionRecords(
  input: AgentSessionTranscriptMetadata,
  records: ReadonlyArray<DecodedTranscriptRecord>,
  claudeFields: ClaudeFields,
  maximumMessages = MAX_IMPORTED_MESSAGES,
  preserveFirstUser = true,
): AgentSessionThread | null {
  const fallbackTimestamp = DateTime.formatIso(DateTime.makeUnsafe(input.lastActiveAtMs));
  // Claude filenames are session IDs. Codex rollout filenames include extra
  // timestamp text, so only transcript metadata can provide a resumable ID.
  let providerSessionId =
    input.source === "codex"
      ? ""
      : input.source === "pi"
        ? records.find((record) => record.type === "session")?.id?.trim() || input.fallbackSessionId
        : (claudeFields.sessionId ?? input.fallbackSessionId);
  // Pi titles a session by its latest session_info on any branch; an empty name clears it.
  const title =
    input.source === "pi"
      ? records.findLast((record) => record.type === "session_info")?.name?.trim() || null
      : (claudeFields.title ?? null);
  let model = claudeFields.model ?? null;
  let derivedTitle: string | undefined;
  let hasCodexSessionId = false;
  const messages: Array<AgentSessionThreadMessage & { readonly codexResponseUser: boolean }> = [];
  let firstUserMessage:
    | (AgentSessionThreadMessage & { readonly codexResponseUser: boolean })
    | undefined;
  const canonicalCodexResponseUserIndices = new Set<number>();
  let canonicalUserTextsInTurn = new Set<string>();
  let responseUsersInTurn: Array<{
    readonly index: number;
    readonly turnId: string;
    readonly text: string;
  }> = [];
  const finishCodexTurn = () => {
    const canonicalTurnIds = new Set(
      responseUsersInTurn.flatMap((responseUser) =>
        canonicalUserTextsInTurn.has(responseUser.text) ? [responseUser.turnId] : [],
      ),
    );
    for (const responseUser of responseUsersInTurn) {
      if (canonicalTurnIds.has(responseUser.turnId)) {
        canonicalCodexResponseUserIndices.add(responseUser.index);
      }
    }
    canonicalUserTextsInTurn = new Set();
    responseUsersInTurn = [];
  };
  if (input.source === "codex") {
    let recordIndex = -1;
    for (const record of records) {
      recordIndex += 1;
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "assistant"
      ) {
        finishCodexTurn();
        continue;
      }
      if (record.type === "event_msg" && record.payload?.type === "user_message") {
        const text = record.payload.message?.trim() ?? "";
        if (text.length > 0) canonicalUserTextsInTurn.add(text);
        continue;
      }
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "user"
      ) {
        const turnId = codexTurnId(record.payload.internal_chat_message_metadata_passthrough);
        const text = extractText(record.payload.content);
        if (turnId !== null && text.length > 0) {
          responseUsersInTurn.push({ index: recordIndex, turnId, text });
        }
      }
    }
    finishCodexTurn();
  }

  let conversationMessageCount = 0;
  const retainMessage = (
    value: AgentSessionThreadMessage & { readonly codexResponseUser: boolean },
    sourceOffset: number | undefined,
  ) => {
    const message =
      !preserveFirstUser && sourceOffset !== undefined ? { ...value, sourceOffset } : value;
    if (firstUserMessage === undefined && message.role === "user") {
      firstUserMessage = message;
    }
    if (derivedTitle === undefined && message.role === "user") {
      derivedTitle = deriveTitle(input.source, message.text);
    }
    conversationMessageCount += 1;
    messages.push(message);
    if (messages.length > maximumMessages) messages.shift();
  };

  const hasMatchingCodexEventInTurn = (text: string) => {
    const comparisonText = text.trim();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "assistant") return false;
      if (
        message?.role === "user" &&
        !message.codexResponseUser &&
        message.text.trim() === comparisonText
      ) {
        return true;
      }
    }
    return false;
  };

  let recordIndex = -1;
  for (const record of input.source === "pi" ? activePiBranch(records) : records) {
    recordIndex += 1;
    if (input.source === "pi") {
      if (!isPiConversationRecord(record)) continue;
      const text = extractText(record.message.content);
      if (text.length === 0) continue;
      retainMessage(
        {
          role: record.message.role,
          text,
          createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
          codexResponseUser: false,
        },
        record.sourceOffset,
      );
      continue;
    }
    if (input.source === "claudeAgent") {
      if (isHiddenClaudeRecord(record)) continue;
      if (record.type !== "user" && record.type !== "assistant") continue;
      const text = extractText(record.message?.content);
      if (text.length === 0) continue;
      retainMessage(
        {
          role: record.type,
          text,
          createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
          codexResponseUser: false,
        },
        record.sourceOffset,
      );
      continue;
    }

    if (record.type === "session_meta") {
      const sessionId = record.payload?.id?.trim() || record.payload?.session_id?.trim();
      if (!hasCodexSessionId && sessionId) {
        providerSessionId = sessionId;
        hasCodexSessionId = true;
      }
      continue;
    }
    if (record.type === "turn_context" && record.payload?.model?.trim()) {
      model = record.payload.model.trim();
      continue;
    }
    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const text = record.payload.message ?? "";
      if (text.trim().length === 0) continue;
      // Codex can duplicate prompts across formats; remove only matching response copies.
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role === "assistant") break;
        if (message?.codexResponseUser === true && message.text.trim() === text.trim()) {
          if (firstUserMessage === message) firstUserMessage = undefined;
          messages.splice(index, 1);
          conversationMessageCount -= 1;
          break;
        }
      }
      retainMessage(
        {
          role: "user",
          text,
          createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
          codexResponseUser: false,
        },
        record.sourceOffset,
      );
      continue;
    }
    if (
      record.type !== "response_item" ||
      record.payload?.type !== "message" ||
      (record.payload.role !== "user" && record.payload.role !== "assistant")
    ) {
      continue;
    }

    const extractedText = extractText(record.payload.content);
    if (extractedText.length === 0) continue;
    if (record.payload.role === "user" && canonicalCodexResponseUserIndices.has(recordIndex)) {
      continue;
    }
    if (record.payload.role === "user" && hasMatchingCodexEventInTurn(extractedText)) {
      continue;
    }
    retainMessage(
      {
        role: record.payload.role,
        text: extractedText,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: record.payload.role === "user",
      },
      record.sourceOffset,
    );
  }

  const visibleMessages = messages.map(
    ({ codexResponseUser: _codexResponseUser, ...message }) => message,
  );
  if (
    providerSessionId.trim().length === 0 ||
    (preserveFirstUser && visibleMessages.length === 0) ||
    (preserveFirstUser && firstUserMessage === undefined)
  )
    return null;
  let retainedMessages = visibleMessages;
  if (preserveFirstUser && firstUserMessage !== undefined && !messages.includes(firstUserMessage)) {
    const { codexResponseUser: _codexResponseUser, ...visibleFirstUserMessage } = firstUserMessage;
    retainedMessages = [visibleFirstUserMessage, ...visibleMessages.slice(-(maximumMessages - 1))];
  }

  return {
    source: input.source,
    providerInstanceId: input.providerInstanceId,
    providerSessionId,
    title: claudeFields.customTitle ?? title ?? derivedTitle ?? "Imported thread",
    model,
    createdAt: retainedMessages[0]?.createdAt ?? fallbackTimestamp,
    updatedAt: fallbackTimestamp,
    messages: retainedMessages,
    omittedMessageCount: conversationMessageCount - retainedMessages.length,
  };
}

function extractDecodedCwd(record: DecodedTranscriptRecord): string | null {
  const cwd = record.cwd?.trim() || record.payload?.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : null;
}

function shouldRetainDecodedRecord(
  source: AgentSessionSource,
  record: DecodedTranscriptRecord,
): boolean {
  // Any Pi entry can be a link on the active branch.
  if (source === "pi") return true;
  if (source === "claudeAgent") {
    if (isHiddenClaudeRecord(record) || (record.type !== "user" && record.type !== "assistant")) {
      return false;
    }
    const content = record.message?.content;
    return typeof content === "string"
      ? content.trim().length > 0
      : (content?.some(
          (block) => isTextContentBlock(block) && (block.text?.trim().length ?? 0) > 0,
        ) ?? false);
  }
  if (extractDecodedCwd(record) !== null) return true;
  return (
    record.type === "session_meta" ||
    record.type === "turn_context" ||
    (record.type === "event_msg" && record.payload?.type === "user_message") ||
    (record.type === "response_item" &&
      record.payload?.type === "message" &&
      (record.payload.role === "user" || record.payload.role === "assistant"))
  );
}

function normalizeForWorktreeMatch(value: string, caseFold: boolean): string {
  const normalized = `${value.replaceAll("\\", "/")}/`;
  return caseFold ? normalized.toLowerCase() : normalized;
}

function isT3ManagedWorktree(
  candidatePath: string,
  worktreesDir: string,
  caseFold: boolean,
): boolean {
  const normalized = normalizeForWorktreeMatch(candidatePath, caseFold);
  return (
    normalized.startsWith(normalizeForWorktreeMatch(worktreesDir, caseFold)) ||
    normalized.includes("/.t3/worktrees/")
  );
}

// false stops metadata scanning for an excluded rollout, even if later records contain a cwd.
function extractCwd(line: string, source: AgentSessionSource): string | null | false {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (typeof record.cwd === "string" && record.cwd.trim().length > 0) {
    return record.cwd;
  }
  const payload = record.payload;
  if (typeof payload === "object" && payload !== null) {
    if (source === "codex" && record.type === "session_meta") {
      const sessionSource = (payload as Record<string, unknown>).source;
      if (
        typeof sessionSource === "object" &&
        sessionSource !== null &&
        !Array.isArray(sessionSource) &&
        (Object.hasOwn(sessionSource, "subagent") || Object.hasOwn(sessionSource, "subAgent"))
      ) {
        return false;
      }
    }
    const nested = (payload as Record<string, unknown>).cwd;
    if (typeof nested === "string" && nested.trim().length > 0) {
      return nested;
    }
  }
  return null;
}

function transcriptIdentity(filePath: string, stats: FileSystem.File.Info) {
  return {
    filePath,
    size: Number(stats.size),
    mtimeMs: Option.match(stats.mtime, { onNone: () => null, onSome: (date) => date.getTime() }),
    device: Number(stats.dev),
    inode: Option.match(stats.ino, { onNone: () => null, onSome: String }),
    birthtimeMs: Option.match(stats.birthtime, {
      onNone: () => null,
      onSome: (date) => date.getTime(),
    }),
  };
}

type TranscriptIdentity = Pick<
  AgentSessionImportSource,
  "filePath" | "size" | "mtimeMs" | "device" | "inode" | "birthtimeMs"
>;

function transcriptRevision(source: TranscriptIdentity): string {
  return [source.device, source.inode, source.birthtimeMs, source.size, source.mtimeMs].join(":");
}

const fileIdKey = (inode: TranscriptIdentity["inode"]) => (inode === null ? null : String(inode));

function sameTranscriptIdentity(left: TranscriptIdentity, right: TranscriptIdentity): boolean {
  // Unsafe legacy numbers may already have lost file ID precision.
  if (
    (typeof left.inode === "number" && !Number.isSafeInteger(left.inode)) ||
    (typeof right.inode === "number" && !Number.isSafeInteger(right.inode))
  ) {
    return false;
  }
  return (
    left.filePath === right.filePath &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.device === right.device &&
    fileIdKey(left.inode) === fileIdKey(right.inode) &&
    left.birthtimeMs === right.birthtimeMs
  );
}

/** @public */
function samePreviewCursor(
  left: AgentSessionPreviewInput["cursor"],
  right: AgentSessionPreviewInput["cursor"],
) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.revision === right.revision &&
    left.before === right.before &&
    left.byteOffset === right.byteOffset &&
    left.textBefore === right.textBefore &&
    left.scan === right.scan
  );
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  // Concurrent client imports must not hold multiple selected-history budgets.
  const importReadLock = yield* Semaphore.make(1);
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const baseDir = yield* fileSystem
    .realPath(path.resolve(serverConfig.baseDir))
    .pipe(Effect.orElseSucceed(() => path.resolve(serverConfig.baseDir)));
  const worktreesDir = yield* fileSystem
    .realPath(path.resolve(serverConfig.worktreesDir))
    .pipe(Effect.orElseSucceed(() => path.resolve(serverConfig.worktreesDir)));
  const isWindows = (yield* HostProcess.Platform) === "win32";
  const foldWorktreeCase = isWindows;
  const hostEnvironment = yield* HostProcess.Environment;
  const homeDir = yield* HostProcess.HomeDirectory;
  // `/private/tmp` is what macOS reports for sessions started in `/tmp`.
  const excludedProjectRoots = new Set(
    [homeDir, NodeOS.tmpdir(), "/tmp", "/private/tmp"].map((directory) =>
      normalizeProjectPathForComparison(path.resolve(directory)),
    ),
  );
  const excludedProjectAncestors = [
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Documents", "Codex"),
  ];

  const isExcludedProjectPath = (candidatePath: string) =>
    excludedProjectRoots.has(normalizeProjectPathForComparison(candidatePath)) ||
    excludedProjectAncestors.some((ancestor) =>
      normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
        normalizeForWorktreeMatch(ancestor, foldWorktreeCase),
      ),
    ) ||
    normalizeForWorktreeMatch(candidatePath, foldWorktreeCase).startsWith(
      normalizeForWorktreeMatch(baseDir, foldWorktreeCase),
    ) ||
    isT3ManagedWorktree(candidatePath, worktreesDir, foldWorktreeCase);

  const statOption = (target: string) =>
    fileSystem.stat(target).pipe(Effect.asSome, Effect.orElseSucceed(Option.none));

  const directoryIdentity = Effect.fn("AgentSessionScanner.directoryIdentity")(function* (
    target: string,
    knownStats?: FileSystem.File.Info,
  ) {
    const resolved = path.resolve(target);
    const stats = knownStats === undefined ? yield* statOption(resolved) : Option.some(knownStats);
    if (Option.isSome(stats) && Option.isSome(stats.value.ino) && stats.value.ino.value > 0n) {
      return `inode:${stats.value.dev}:${stats.value.ino.value}`;
    }
    const realPath = yield* fileSystem
      .realPath(resolved)
      .pipe(Effect.orElseSucceed(() => resolved));
    return `path:${normalizeProjectPathForComparison(realPath)}`;
  });

  // Paths whose own read outlived the deadline, mapped to when they may be read
  // again. Without this every later scan would wait out the deadline again for
  // each phase that touches them.
  const blockedGitFilePaths = new Map<string, number>();

  /** Reads small files without the libuv pool; "" when missing, unreadable or blocked. */
  const readGitFiles = Effect.fn("AgentSessionScanner.readGitFiles")(function* (
    filePaths: ReadonlyArray<string>,
  ) {
    const unique = Array.from(new Set(filePaths));
    const now = yield* Clock.currentTimeMillis;
    const contents = yield* Effect.forEach(
      unique,
      (filePath) => {
        // No privacy prompts or FIFOs to block open() here.
        if (isWindows) {
          return fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
        }
        if ((blockedGitFilePaths.get(filePath) ?? 0) > now) return Effect.succeed("");
        blockedGitFilePaths.delete(filePath);
        return processRunner
          .run({
            command: "cat",
            args: ["--", filePath],
            timeout: GIT_FILE_READ_DEADLINE,
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: MAX_GIT_FILE_BYTES,
            outputMode: "truncate",
          })
          .pipe(
            Effect.map((result) => {
              if (result.timedOut) {
                if (blockedGitFilePaths.size >= MAX_BLOCKED_GIT_FILE_PATHS) {
                  blockedGitFilePaths.delete(blockedGitFilePaths.keys().next().value!);
                }
                blockedGitFilePaths.set(filePath, now + BLOCKED_GIT_FILE_RETRY_MS);
              }
              return result.code === 0 ? result.stdout : "";
            }),
            Effect.orElseSucceed(() => ""),
          );
      },
      { concurrency: isWindows ? 1 : GIT_FILE_READ_CONCURRENCY },
    );
    return new Map(unique.map((filePath, index) => [filePath, contents[index]!]));
  });

  /** Reads every directory's git identity in three phases of concurrent reads. */
  const readGitIdentities = Effect.fn("AgentSessionScanner.readGitIdentities")(function* (
    directories: ReadonlyArray<string>,
  ) {
    type GitIdentity =
      | { readonly _tag: "Repository"; readonly git: AgentSessionProjectGit | null }
      | { readonly _tag: "Worktree" }
      | { readonly _tag: "NotGit" };
    const identities = new Map<string, GitIdentity>();
    const repositories: Array<{ directory: string; gitDir: string; linkedWorktree: boolean }> = [];
    const pointers: Array<{ directory: string; gitPath: string }> = [];
    for (const directory of directories) {
      const gitPath = path.join(directory, ".git");
      const gitStats = yield* statOption(gitPath);
      if (Option.isNone(gitStats)) identities.set(directory, { _tag: "NotGit" });
      else if (gitStats.value.type === "Directory") {
        repositories.push({ directory, gitDir: gitPath, linkedWorktree: false });
      } else pointers.push({ directory, gitPath });
    }

    const pointerTexts = yield* readGitFiles(pointers.map(({ gitPath }) => gitPath));
    const linkedWorktrees: Array<{ directory: string; gitDir: string }> = [];
    for (const { directory, gitPath } of pointers) {
      const target = /^gitdir:\s*(.+)$/m.exec(pointerTexts.get(gitPath) ?? "")?.[1]?.trim();
      if (target === undefined || target.length === 0) {
        identities.set(directory, { _tag: "NotGit" });
        continue;
      }
      const gitDir = path.resolve(directory, target);
      if (/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir)) {
        linkedWorktrees.push({ directory, gitDir });
      } else repositories.push({ directory, gitDir, linkedWorktree: false });
    }

    const commonDirTexts = yield* readGitFiles(
      linkedWorktrees.map(({ gitDir }) => path.join(gitDir, "commondir")),
    );
    for (const { directory, gitDir } of linkedWorktrees) {
      const commonDir = (commonDirTexts.get(path.join(gitDir, "commondir")) ?? "").trim();
      if (commonDir.length === 0) identities.set(directory, { _tag: "Worktree" });
      else
        repositories.push({
          directory,
          gitDir: path.resolve(gitDir, commonDir),
          linkedWorktree: true,
        });
    }

    const configTexts = yield* readGitFiles(
      repositories.map(({ gitDir }) => path.join(gitDir, "config")),
    );
    for (const { directory, gitDir, linkedWorktree } of repositories) {
      const configText = configTexts.get(path.join(gitDir, "config")) ?? "";
      // Bare repositories have no main checkout, so offer their linked worktrees independently.
      if (linkedWorktree && !isBareGitConfig(configText)) {
        identities.set(directory, { _tag: "Worktree" });
        continue;
      }
      const originUrl = parseOriginUrlFromGitConfig(configText);
      identities.set(directory, {
        _tag: "Repository",
        git: {
          remoteKey:
            originUrl === null ? null : sourceControlDefinitions.repositoryKeyFromRemote(originUrl),
          repository: repositoryPathFromRemoteUrl(originUrl),
        },
      });
    }
    return identities;
  });

  const readCwd = Effect.fn("AgentSessionScanner.readCwd")(function* (
    source: AgentSessionSource,
    transcript: TranscriptCandidate,
    budget: MetadataReadBudget,
  ) {
    const readMetadata = (line: string) => {
      const cwd = extractCwd(line, source);
      if (cwd === null || cwd === false) return cwd;
      const decoded = decodeTranscriptRecord(line);
      const record = Option.getOrUndefined(decoded);
      const nativeId =
        source === "codex"
          ? record?.payload?.id?.trim() || record?.payload?.session_id
          : source === "claudeAgent"
            ? record?.sessionId
            : record?.id;
      return {
        cwd,
        providerSessionId: nativeId?.trim() || path.basename(transcript.filePath, ".jsonl"),
        title: undefined as string | undefined,
      };
    };
    if (transcript.size === 0) return null;
    if (
      budget.bytesRemaining === 0 ||
      budget.operationsRemaining < 2 ||
      budget.recordsRemaining === 0
    ) {
      budget.truncated = true;
      return null;
    }
    budget.operationsRemaining -= 1;
    return yield* Effect.scoped(
      fileSystem.open(transcript.filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            const decoder = new TextDecoder();
            let remaining = "";
            let bytesRead = 0;
            let recordsRead = 0;
            const maxBytes = Math.min(MAX_TRANSCRIPT_SCAN_BYTES, transcript.size);
            const reserveRecord = () => {
              if (
                recordsRead === MAX_METADATA_RECORDS_PER_TRANSCRIPT ||
                budget.recordsRemaining === 0
              ) {
                budget.truncated = true;
                return false;
              }
              recordsRead += 1;
              budget.recordsRemaining -= 1;
              return true;
            };
            const readLastRecord = () => {
              const record = remaining + decoder.decode();
              return record.length === 0 || !reserveRecord() ? null : readMetadata(record.trim());
            };

            while (bytesRead < maxBytes) {
              if (budget.bytesRemaining === 0 || budget.operationsRemaining === 0) {
                budget.truncated = true;
                return null;
              }
              const readSize = Math.min(
                METADATA_READ_BYTES,
                maxBytes - bytesRead,
                budget.bytesRemaining,
              );
              budget.operationsRemaining -= 1;
              budget.bytesRemaining -= readSize;
              const next = yield* file.readAlloc(readSize);
              if (Option.isNone(next)) {
                return readLastRecord();
              }

              bytesRead += next.value.byteLength;
              remaining += decoder.decode(next.value, { stream: true });
              const lines = remaining.split("\n");
              remaining = lines.pop() ?? "";

              for (const line of lines) {
                if (!reserveRecord()) return null;
                const cwd = readMetadata(line.trim());
                if (cwd !== null) {
                  if (cwd === false) return false;
                  // Reuse the metadata chunk already read; listing never reads a transcript for its title.
                  const thread = parseAgentSessionTranscript({
                    source,
                    providerInstanceId: transcript.providerInstanceId,
                    fallbackSessionId: cwd.providerSessionId,
                    lastActiveAtMs: transcript.mtimeMs,
                    contents: [
                      ...lines,
                      ...(bytesRead === transcript.size ? [remaining] : []),
                    ].join("\n"),
                  });
                  return { ...cwd, title: thread?.title };
                }
              }
            }

            if (bytesRead < transcript.size) {
              budget.truncated = true;
              return null;
            }
            return readLastRecord();
          }),
        ),
      ),
    ).pipe(Effect.orElseSucceed(() => null));
  });

  const readTranscript = Effect.fn("AgentSessionScanner.readTranscript")(function* (
    filePath: string,
    expected: ReturnType<typeof transcriptIdentity>,
    source: AgentSessionSource,
  ) {
    if (expected.size > MAX_IMPORTED_TRANSCRIPT_BYTES) return null;

    return yield* Effect.scoped(
      fileSystem.open(filePath, { flag: "r" }).pipe(
        Effect.flatMap((file) =>
          Effect.gen(function* () {
            if (!sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))) {
              return null;
            }
            const records: Array<DecodedTranscriptRecord> = [];
            let cwd = Option.none<string>();
            let claudeFields = emptyClaudeFields;
            let historyBytes = 0;
            let recordBytes = 0;
            let recordCount = 0;
            let bytesRead = 0;
            let recordOffset = 0;
            const reserve = (bytes: number) => {
              recordBytes += bytes;
              if (historyBytes + recordBytes > MAX_IMPORT_HISTORY_BYTES) {
                throw new TranscriptJsonLimitError(
                  "Transcript selected history exceeds the 32 MiB memory budget",
                );
              }
            };
            let reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
            let decoder = new TextDecoder();
            let recordStarted = false;

            const finishRecord = () => {
              reader.write(decoder.decode());
              recordCount += 1;
              if (recordCount > MAX_IMPORT_RECORDS) return false;
              const value = reader.finish();
              const decoded = decodeTranscriptValue(value);
              if (Option.isNone(decoded) && source === "pi") {
                // Pi accepts messages this schema rejects, such as null content; keep their tree links.
                records.push(...Option.toArray(decodePiEntryLinks(value)));
              } else if (Option.isSome(decoded)) {
                if (Option.isNone(cwd)) cwd = Option.fromNullOr(extractDecodedCwd(decoded.value));
                if (source === "claudeAgent") {
                  claudeFields = foldClaudeFields(claudeFields, decoded.value);
                }
                if (shouldRetainDecodedRecord(source, decoded.value)) {
                  if (
                    source === "pi" &&
                    decoded.value.type === "message" &&
                    !isPiConversationRecord(decoded.value)
                  ) {
                    // Tool output can dwarf the conversation; keep only the tree links.
                    const { message: _message, ...links } = decoded.value;
                    records.push(links);
                  } else {
                    records.push({ ...decoded.value, sourceOffset: recordOffset });
                    historyBytes += recordBytes;
                  }
                }
              }
              recordBytes = 0;
              reader = createTranscriptJsonReader(reserve, selectTranscriptPath);
              decoder = new TextDecoder();
              recordStarted = false;
              return true;
            };

            while (bytesRead < expected.size) {
              const next = yield* file.readAlloc(
                Math.min(TRANSCRIPT_PREFIX_BYTES, expected.size - bytesRead),
              );
              if (Option.isNone(next)) {
                return null;
              }

              bytesRead += next.value.byteLength;
              const withinBudget = yield* Effect.try(() => {
                let start = 0;
                while (start < next.value.byteLength) {
                  const newline = next.value.indexOf(10, start);
                  const end = newline === -1 ? next.value.byteLength : newline;
                  recordStarted = true;
                  reader.write(decoder.decode(next.value.subarray(start, end), { stream: true }));
                  if (newline === -1) break;
                  if (!finishRecord()) return false;
                  recordOffset = bytesRead - next.value.byteLength + newline + 1;
                  start = newline + 1;
                }
                return true;
              });
              if (!withinBudget) return null;
            }

            if (recordStarted && !(yield* Effect.try(finishRecord))) return null;
            return sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))
              ? { records, recordCount, cwd, claudeFields, olderByteOffset: 0 }
              : null;
          }),
        ),
      ),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read imported transcript", { filePath, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
  });

  const previewIndexes = new Map<
    string,
    {
      index: ReturnType<typeof createPreviewIndex>;
      directory: string;
      identity: TranscriptIdentity;
      source: AgentSessionImportSource;
      thread: AgentSessionThread;
      cutoff: number;
      recentResult: AgentSessionPreviewResult;
      cursor: NonNullable<AgentSessionPreviewInput["cursor"]>;
    }
  >();
  const discardPreviewIndex = Effect.fn("AgentSessionScanner.discardPreviewIndex")(function* (
    token: string,
  ) {
    const state = previewIndexes.get(token);
    if (!state) return;
    previewIndexes.delete(token);
    yield* Effect.try(() => state.index.close()).pipe(Effect.ignore);
    yield* fileSystem.remove(state.directory, { recursive: true }).pipe(Effect.ignore);
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach(previewIndexes.keys(), discardPreviewIndex, { discard: true }),
  );

  const startPreviewIndex = Effect.fn("AgentSessionScanner.startPreviewIndex")(function* (
    identity: TranscriptIdentity,
    source: AgentSessionImportSource,
    thread: AgentSessionThread,
    cutoff: number,
    metadata: DecodedTranscriptRecord,
  ) {
    for (const [token, state] of previewIndexes) {
      if (
        sameTranscriptIdentity(state.identity, identity) &&
        state.source.providerInstanceId === source.providerInstanceId &&
        state.source.providerSessionId === source.providerSessionId &&
        state.cutoff === cutoff
      ) {
        previewIndexes.delete(token);
        previewIndexes.set(token, state);
        return state.recentResult;
      }
    }
    while (previewIndexes.size >= 4) {
      const oldest = previewIndexes.entries().next().value;
      if (!oldest) break;
      yield* discardPreviewIndex(oldest[0]);
    }
    const directory = yield* fileSystem.makeTempDirectory({ prefix: "t3-history-preview-" });
    const token = NodeCrypto.randomUUID();
    const index = yield* Effect.try(() =>
      createPreviewIndex(
        path.join(directory, "history.sqlite"),
        source.provider,
        selectTranscriptPath,
        (value) => {
          const decoded = decodeTranscriptValue(value);
          const record =
            Option.getOrUndefined(decoded) ??
            (source.provider === "pi"
              ? Option.getOrUndefined(decodePiEntryLinks(value))
              : undefined);
          if (!record) return undefined;
          const full = Option.getOrUndefined(decoded);
          const parsed = full
            ? parseAgentSessionRecords(
                {
                  source: source.provider,
                  providerInstanceId: source.providerInstanceId,
                  fallbackSessionId: source.providerSessionId,
                  lastActiveAtMs: source.mtimeMs ?? 0,
                },
                [metadata, full],
                source.provider === "claudeAgent"
                  ? foldClaudeFields(emptyClaudeFields, full)
                  : emptyClaudeFields,
                1,
                false,
              )
            : null;
          const message = parsed?.messages.at(-1);
          const assistantBoundary =
            source.provider === "codex" &&
            full?.type === "response_item" &&
            full.payload?.type === "message" &&
            full.payload.role === "assistant";
          if (source.provider !== "pi" && !message && !assistantBoundary) return undefined;
          return {
            ...(record.id === undefined ? {} : { id: record.id }),
            ...(record.parentId === undefined ? {} : { parentId: record.parentId }),
            session: record.type === "session" || record.type === "session_meta",
            ...(message
              ? { role: message.role, text: message.text, createdAt: message.createdAt }
              : assistantBoundary
                ? { role: "assistant" as const }
                : {}),
            canonical: record.type === "event_msg" && full?.payload?.type === "user_message",
            turnId: codexTurnId(full?.payload?.internal_chat_message_metadata_passthrough),
          };
        },
      ),
    ).pipe(
      Effect.onError(() => fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore)),
    );
    const cursor = { revision: transcriptRevision(identity), before: 0, scan: token };
    const initialResult = {
      status: "ready",
      revision: cursor.revision,
      title: thread.title,
      model: thread.model,
      boundedWindow: true,
      messages: [],
      nextCursor: cursor,
    } satisfies AgentSessionPreviewResult;
    previewIndexes.set(token, {
      index,
      directory,
      identity,
      source,
      thread: { ...thread, messages: [] },
      cutoff,
      recentResult: initialResult,
      cursor,
    });
    return initialResult;
  });

  const continuePreviewIndex = Effect.fn("AgentSessionScanner.continuePreviewIndex")(function* (
    identity: TranscriptIdentity,
    session: NonNullable<AgentSessionImportInput["session"]>,
    cursor: NonNullable<AgentSessionPreviewInput["cursor"]>,
  ) {
    const state = cursor.scan === undefined ? undefined : previewIndexes.get(cursor.scan);
    if (
      !state ||
      state.source.providerInstanceId !== session.providerInstanceId ||
      state.source.providerSessionId !== session.providerSessionId ||
      state.identity.filePath !== identity.filePath
    )
      return undefined;
    if (
      !sameTranscriptIdentity(state.identity, identity) ||
      cursor.revision !== transcriptRevision(identity)
    ) {
      if (!sameTranscriptIdentity(state.identity, identity))
        yield* discardPreviewIndex(cursor.scan!);
      return { ...state, result: { status: "unavailable", reason: "changed" } as const };
    }
    const cursorCodec = Schema.fromJsonString(AgentSessionPreviewInput.fields.cursor);
    const resultCodec = Schema.fromJsonString(AgentSessionPreviewResult);
    const previous = yield* Effect.try(() => state.index.readPage(cursor.before));
    if (
      previous &&
      samePreviewCursor(cursor, yield* Schema.decodeEffect(cursorCodec)(previous.input))
    ) {
      previewIndexes.delete(cursor.scan!);
      previewIndexes.set(cursor.scan!, state);
      return { ...state, result: yield* Schema.decodeEffect(resultCodec)(previous.result) };
    }
    if (!samePreviewCursor(cursor, state.cursor)) return undefined;
    previewIndexes.delete(cursor.scan!);
    previewIndexes.set(cursor.scan!, state);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(identity.filePath, { flag: "r" });
        if (
          !sameTranscriptIdentity(identity, transcriptIdentity(identity.filePath, yield* file.stat))
        )
          return yield* new AgentSessionScanError({
            operation: "read-projects",
            cause: "Transcript changed",
          });
        yield* file.seek(BigInt(state.index.offset), "start");
        let budget = MAX_PREVIEW_BYTES;
        const startingRecordCount = state.index.recordCount;
        while (
          state.index.phase === "read" &&
          budget > 0 &&
          state.index.recordCount - startingRecordCount < MAX_IMPORT_RECORDS
        ) {
          const chunk = yield* file.readAlloc(
            Math.min(TRANSCRIPT_PREFIX_BYTES, budget, identity.size - state.index.offset),
          );
          if (Option.isNone(chunk) || chunk.value.length === 0)
            return yield* new AgentSessionScanError({
              operation: "read-projects",
              cause: "Transcript ended early",
            });
          budget -= chunk.value.length;
          yield* Effect.try(() =>
            state.index.write(
              chunk.value,
              state.index.offset + chunk.value.length === identity.size,
              MAX_IMPORT_RECORDS - (state.index.recordCount - startingRecordCount),
            ),
          );
        }
        if (
          !sameTranscriptIdentity(identity, transcriptIdentity(identity.filePath, yield* file.stat))
        )
          return yield* new AgentSessionScanError({
            operation: "read-projects",
            cause: "Transcript changed",
          });
      }),
    );
    if (state.index.phase !== "read") yield* Effect.try(() => state.index.advance());
    const page =
      state.index.phase === "ready"
        ? yield* Effect.try(() => state.index.page(state.cutoff))
        : undefined;
    state.cursor = {
      revision: cursor.revision,
      before: cursor.before + 1,
      scan: cursor.scan!,
      ...(page?.textBefore === undefined ? {} : { textBefore: page.textBefore }),
    };
    const result = {
      status: "ready",
      revision: cursor.revision,
      title: state.thread.title,
      model: state.thread.model,
      boundedWindow: true,
      messages:
        page?.messages.map(({ sourceOffset, textOffset, ...message }) => ({
          ...message,
          id: `${state.source.providerInstanceId}:${state.source.providerSessionId}:${sourceOffset}${message.truncated ? `:${textOffset}` : ""}`,
        })) ?? [],
      nextCursor: page?.complete ? null : state.cursor,
    } satisfies AgentSessionPreviewResult;
    const encodedCursor = yield* Schema.encodeEffect(cursorCodec)(cursor);
    const encodedResult = yield* Schema.encodeEffect(resultCodec)(result);
    yield* Effect.try(() => state.index.savePage(cursor.before, encodedCursor, encodedResult));
    if (page && state.recentResult.status === "ready" && state.recentResult.messages.length === 0)
      state.recentResult = result;
    return { ...state, result };
  });

  const readPreviewWindow = Effect.fn("AgentSessionScanner.readPreviewTail")(function* (
    filePath: string,
    expected: ReturnType<typeof transcriptIdentity>,
    source: AgentSessionSource,
    byteOffset = expected.size,
    discovered?: RawCandidate["transcripts"][number]["discovered"],
  ) {
    if (!Number.isSafeInteger(byteOffset) || byteOffset <= 0 || byteOffset > expected.size)
      return null;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(filePath, { flag: "r" });
        if (!sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat)))
          return null;
        const readBytes = Effect.fn("AgentSessionScanner.readPreviewBytes")(function* (
          length: number,
        ) {
          const bytes = new Uint8Array(length);
          let offset = 0;
          while (offset < length) {
            const chunk = yield* file.readAlloc(length - offset);
            if (Option.isNone(chunk) || chunk.value.byteLength === 0) return null;
            bytes.set(chunk.value, offset);
            offset += chunk.value.byteLength;
          }
          return bytes;
        });
        let metadata: DecodedTranscriptRecord;
        let cwd: string;
        if (discovered && sameTranscriptIdentity(expected, discovered.identity)) {
          metadata = { ...discovered.record, message: undefined };
          cwd = extractDecodedCwd(metadata) ?? "";
        } else {
          const prefix = yield* readBytes(Math.min(MAX_TRANSCRIPT_SCAN_BYTES, expected.size));
          if (prefix === null) return null;
          const lines = new TextDecoder().decode(prefix).split("\n");
          if (prefix.byteLength < expected.size) lines.pop();
          const metadataLine = lines.find((line) => extractCwd(line, source) !== null);
          if (metadataLine === undefined) return null;
          const extracted = extractCwd(metadataLine, source);
          if (!extracted) return null;
          cwd = extracted;
          const decoded = decodeTranscriptRecord(metadataLine);
          if (Option.isNone(decoded)) return null;
          metadata = { ...decoded.value, message: undefined };
        }
        if (source === "pi")
          return {
            records: [metadata],
            olderByteOffset: expected.size,
            recordCount: 1,
            cwd: Option.some(cwd),
            claudeFields: emptyClaudeFields,
          };
        const windowStart = Math.max(0, byteOffset - MAX_PREVIEW_BYTES);
        yield* file.seek(BigInt(windowStart), "start");
        const tail = yield* readBytes(byteOffset - windowStart);
        if (
          tail === null ||
          !sameTranscriptIdentity(expected, transcriptIdentity(filePath, yield* file.stat))
        )
          return null;
        // The window may begin inside a tool record or a UTF-8 sequence.
        const newline = tail.indexOf(10);
        const firstRecord = windowStart === 0 ? 0 : newline === -1 ? tail.byteLength : newline + 1;
        const decoder = new TextDecoder();
        let recordCount = 0;
        let selectedBytes = 0;
        const records: Array<DecodedTranscriptRecord> = [];
        let end = tail.byteLength;
        let olderByteOffset =
          windowStart === 0 ? 0 : windowStart + (firstRecord < tail.byteLength ? firstRecord : 0);
        yield* Effect.try(() => {
          while (end > firstRecord && recordCount < MAX_IMPORT_RECORDS) {
            const contentEnd = tail[end - 1] === 10 ? end - 1 : end;
            const start = Math.max(
              firstRecord,
              contentEnd === 0 ? 0 : tail.lastIndexOf(10, contentEnd - 1) + 1,
            );
            const reader = createTranscriptJsonReader((bytes) => {
              selectedBytes += bytes;
              if (selectedBytes > MAX_IMPORT_HISTORY_BYTES)
                throw new TranscriptJsonLimitError("Transcript preview exceeds the memory budget");
            }, selectTranscriptPath);
            reader.write(decoder.decode(tail.subarray(start, contentEnd)));
            const record = decodeTranscriptValue(reader.finish());
            recordCount += 1;
            if (Option.isSome(record))
              records.push({ ...record.value, sourceOffset: windowStart + start });
            end = start;
          }
        });
        if (end > firstRecord) olderByteOffset = windowStart + end;
        records.reverse();
        records.unshift(metadata);
        return {
          records,
          olderByteOffset,
          recordCount: records.length,
          cwd: Option.some(cwd),
          claudeFields:
            source === "claudeAgent"
              ? records.reduce(foldClaudeFields, emptyClaudeFields)
              : emptyClaudeFields,
        };
      }),
    ).pipe(Effect.orElseSucceed(() => null));
  });

  const readCodexThreadNames = Effect.fn("AgentSessionScanner.readCodexThreadNames")(function* (
    homePath: string,
  ) {
    const indexPath = path.join(homePath, "session_index.jsonl");
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(indexPath, { flag: "r" });
        const size = Number((yield* file.stat).size);
        const start = Math.max(0, size - MAX_CODEX_SESSION_INDEX_BYTES);
        yield* file.seek(BigInt(start), "start");
        const bytes = yield* file.readAlloc(size - start);
        const contents = Option.match(bytes, {
          onNone: () => "",
          onSome: (value) => new TextDecoder().decode(value),
        });
        // A tail read can start mid-record.
        return parseCodexThreadNames(
          start > 0 ? contents.slice(contents.indexOf("\n") + 1) : contents,
        );
      }),
    ).pipe(Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()));
  });

  const resolveClaudeConfigDir = (homePath: string, environmentHome?: string): string => {
    const configured = homePath.trim();
    if (configured.length > 0) {
      return path.resolve(expandHomePath(configured, homeDir));
    }
    const fromEnvironment = environmentHome?.trim() ?? "";
    if (fromEnvironment.length > 0) {
      return path.resolve(expandHomePath(fromEnvironment, homeDir));
    }
    return path.join(homeDir, ".claude");
  };

  const discoverClaudeTranscripts = Effect.fn("AgentSessionScanner.discoverClaudeTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const projectsDir = path.join(homePath, "projects");
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return Effect.tryPromise(() => readDiscoveryDirectory(directory, operationsRemaining)).pipe(
          Effect.map((result) => {
            operationsRemaining -= result.entries.length;
            truncated ||= result.truncated;
            return result.entries;
          }),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
      };
      const projectDirectories = yield* readDirectory(projectsDir);
      const transcripts: Array<TranscriptCandidate> = [];

      for (const projectDirectory of projectDirectories) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        const directory = path.join(projectsDir, projectDirectory);
        const directoryTranscripts = (yield* readDirectory(directory))
          .filter((entry) => entry.endsWith(".jsonl"))
          .map((entry) => path.join(directory, entry));

        for (const filePath of directoryTranscripts) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          operationsRemaining -= 1;
          const stats = yield* statOption(filePath);
          if (
            Option.isNone(stats) ||
            stats.value.type !== "File" ||
            Option.isNone(stats.value.mtime)
          ) {
            continue;
          }
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId,
            homePath,
            size: Number(stats.value.size),
          });
        }
      }
      return { transcripts, truncated };
    },
  );

  const discoverCodexTranscripts = Effect.fn("AgentSessionScanner.discoverCodexTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const sessionsDir = path.join(homePath, "sessions");

      const transcripts: Array<TranscriptCandidate> = [];
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return Effect.tryPromise(() => readDiscoveryDirectory(directory, operationsRemaining)).pipe(
          Effect.map((result) => {
            operationsRemaining -= result.entries.length;
            truncated ||= result.truncated;
            return result.entries;
          }),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
      };
      for (const year of (yield* readDirectory(sessionsDir)).toSorted().toReversed()) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        for (const month of (yield* readDirectory(path.join(sessionsDir, year)))
          .toSorted()
          .toReversed()) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          for (const day of (yield* readDirectory(path.join(sessionsDir, year, month)))
            .toSorted()
            .toReversed()) {
            if (operationsRemaining <= 0) {
              truncated = true;
              break;
            }
            const directory = path.join(sessionsDir, year, month, day);
            for (const entry of (yield* readDirectory(directory)).toSorted().toReversed()) {
              if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
              if (operationsRemaining <= 0) {
                truncated = true;
                break;
              }
              const filePath = path.join(directory, entry);
              operationsRemaining -= 1;
              const stats = yield* statOption(filePath);
              if (
                Option.isSome(stats) &&
                stats.value.type === "File" &&
                Option.isSome(stats.value.mtime)
              ) {
                transcripts.push({
                  filePath,
                  mtimeMs: stats.value.mtime.value.getTime(),
                  providerInstanceId,
                  homePath,
                  size: Number(stats.value.size),
                });
              }
            }
          }
        }
      }
      return { transcripts, truncated };
    },
  );

  // Pi nests sessions in one directory per cwd, but a custom session directory holds them flat.
  const discoverPiTranscripts = Effect.fn("AgentSessionScanner.discoverPiTranscripts")(function* (
    sessionsDir: string,
    providerInstanceId: ProviderInstanceId,
    operationBudget: number,
  ) {
    let operationsRemaining = operationBudget;
    let truncated = false;
    const readDirectory = (directory: string) => {
      if (operationsRemaining <= 0) {
        truncated = true;
        return Effect.succeed<ReadonlyArray<string>>([]);
      }
      operationsRemaining -= 1;
      return Effect.tryPromise(() => readDiscoveryDirectory(directory, operationsRemaining)).pipe(
        Effect.map((result) => {
          operationsRemaining -= result.entries.length;
          truncated ||= result.truncated;
          return result.entries;
        }),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );
    };
    const transcripts: Array<TranscriptCandidate> = [];
    for (const entry of yield* readDirectory(sessionsDir)) {
      if (operationsRemaining <= 0) {
        truncated = true;
        break;
      }
      const entryPath = path.join(sessionsDir, entry);
      const filePaths = entry.endsWith(".jsonl")
        ? [entryPath]
        : (yield* readDirectory(entryPath))
            .filter((nested) => nested.endsWith(".jsonl"))
            .map((nested) => path.join(entryPath, nested));

      for (const filePath of filePaths) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        operationsRemaining -= 1;
        const stats = yield* statOption(filePath);
        if (
          Option.isSome(stats) &&
          stats.value.type === "File" &&
          Option.isSome(stats.value.mtime)
        ) {
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId,
            homePath: sessionsDir,
            size: Number(stats.value.size),
          });
        }
      }
    }
    return { transcripts, truncated };
  });

  const groupTranscriptsByCwd = Effect.fn("AgentSessionScanner.groupTranscriptsByCwd")(function* (
    source: AgentSessionSource,
    transcripts: ReadonlyArray<TranscriptCandidate>,
    budget: MetadataReadBudget,
  ) {
    const byOwnerAndCwd = new Map<
      string,
      {
        cwd: string;
        providerInstanceId: ProviderInstanceId;
        homePath: string;
        lastActiveAtMs: number;
        transcripts: Array<{
          filePath: string;
          mtimeMs: number;
          providerSessionId: string;
          title: string | undefined;
        }>;
      }
    >();

    for (const transcript of transcripts) {
      const metadata = yield* readCwd(source, transcript, budget);
      if (metadata === null || metadata === false) continue;
      const { cwd, providerSessionId, title } = metadata;
      const key = `${transcript.providerInstanceId}\0${cwd}`;
      const existing = byOwnerAndCwd.get(key);
      if (existing) {
        existing.lastActiveAtMs = Math.max(existing.lastActiveAtMs, transcript.mtimeMs);
        existing.transcripts.push({ ...transcript, providerSessionId, title });
      } else {
        byOwnerAndCwd.set(key, {
          cwd,
          providerInstanceId: transcript.providerInstanceId,
          homePath: transcript.homePath,
          lastActiveAtMs: transcript.mtimeMs,
          transcripts: [{ ...transcript, providerSessionId, title }],
        });
      }
    }

    return Array.from(byOwnerAndCwd.values(), (group): RawCandidate => ({
      cwd: group.cwd,
      source,
      providerInstanceId: group.providerInstanceId,
      homePath: group.homePath,
      threadCount: group.transcripts.length,
      lastActiveAtMs: group.lastActiveAtMs,
      transcripts: group.transcripts,
    }));
  });

  const collectCandidates = Effect.fn("AgentSessionScanner.collectCandidates")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-settings", cause })),
    );

    const raw: Array<RawCandidate> = [];
    let truncated = false;
    const discoveryHomes: Array<DiscoveryHome> = [];

    for (const source of ["claudeAgent", "codex", "pi"] as const) {
      const instances: Array<{
        readonly instanceId: ProviderInstanceId;
        readonly config: ProviderInstanceConfig;
      }> = Object.entries(settings.providerInstances)
        .filter(
          ([, instance]) => instance.driver === source && resolveProviderInstanceEnabled(instance),
        )
        .map(([instanceId, config]) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          config,
        }));
      if (!Object.hasOwn(settings.providerInstances, source)) {
        const defaultInstance = {
          instanceId: ProviderInstanceId.make(source),
          config: { driver: ProviderDriverKind.make(source) },
        };
        if (resolveProviderInstanceEnabled(defaultInstance.config)) {
          instances.push(defaultInstance);
        }
      }

      instances.sort((left, right) => {
        const leftDefault = left.instanceId === source ? 0 : 1;
        const rightDefault = right.instanceId === source ? 0 : 1;
        return leftDefault - rightDefault;
      });
      const homes: Array<{ homePath: string; providerInstanceId: ProviderInstanceId }> = [];
      const seenHomes = new Set<string>();
      for (const { instanceId, config: instance } of instances) {
        const environmentHome = (name: "CLAUDE_CONFIG_DIR" | "CODEX_HOME") => {
          const configured = instance.environment?.findLast(
            (variable) => variable.name === name,
          )?.value;
          return typeof configured === "string" ? configured : hostEnvironment[name];
        };

        let homePath: string;
        if (source === "pi") {
          const environment = yield* mergeProviderInstanceEnvironment(
            instance.environment,
            hostEnvironment,
          ).pipe(Effect.provideService(HostProcess.HomeDirectory, homeDir));
          homePath = resolvePiSessionsDir(environment, homeDir, path);
        } else if (source === "claudeAgent") {
          const config = decodeClaudeSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          homePath = resolveClaudeConfigDir(
            config.value.homePath,
            environmentHome("CLAUDE_CONFIG_DIR"),
          );
        } else {
          const config = decodeCodexSettings(instance.config ?? {});
          if (Option.isNone(config)) continue;
          const codexHome = environmentHome("CODEX_HOME");
          const codexSettings =
            config.value.homePath.trim().length === 0 &&
            config.value.shadowHomePath.trim().length === 0 &&
            codexHome?.trim()
              ? { ...config.value, homePath: codexHome }
              : config.value;
          const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
            Effect.provideService(Path.Path, path),
          );
          homePath = layout.sharedHomePath;
        }

        const homeKey = `${source}\0${yield* directoryIdentity(homePath)}`;
        if (seenHomes.has(homeKey)) continue;
        seenHomes.add(homeKey);
        homes.push({ homePath, providerInstanceId: instanceId });
      }

      discoveryHomes.push(...homes.map((home) => ({ ...home, source })));
      const transcriptCandidates: Array<TranscriptCandidate> = [];
      const baseOperationBudget = Math.floor(
        MAX_DISCOVERY_OPERATIONS_PER_SOURCE / Math.max(1, homes.length),
      );
      const extraOperationBudgets = MAX_DISCOVERY_OPERATIONS_PER_SOURCE % Math.max(1, homes.length);
      for (const [index, home] of homes.entries()) {
        const operationBudget = baseOperationBudget + (index < extraOperationBudgets ? 1 : 0);
        if (operationBudget === 0) {
          truncated = true;
          continue;
        }
        const discover =
          source === "claudeAgent"
            ? discoverClaudeTranscripts
            : source === "codex"
              ? discoverCodexTranscripts
              : discoverPiTranscripts;
        const discovered = yield* discover(home.homePath, home.providerInstanceId, operationBudget);
        truncated ||= discovered.truncated;
        transcriptCandidates.push(...discovered.transcripts);
      }

      transcriptCandidates.sort(
        (left, right) =>
          right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath),
      );
      if (transcriptCandidates.length > MAX_TRANSCRIPTS_PER_SOURCE) {
        truncated = true;
      }
      const selectedTranscripts = selectMetadataTranscripts(transcriptCandidates);
      const metadataBudget: MetadataReadBudget = {
        bytesRemaining: MAX_METADATA_BYTES_PER_SOURCE,
        operationsRemaining: MAX_METADATA_OPERATIONS_PER_SOURCE,
        recordsRemaining: MAX_METADATA_RECORDS_PER_SOURCE,
        truncated: false,
      };
      raw.push(...(yield* groupTranscriptsByCwd(source, selectedTranscripts, metadataBudget)));
      truncated ||= metadataBudget.truncated;
    }

    return { candidates: raw, truncated, discoveryHomes };
  });

  let cachedCandidates: ReadonlyArray<RawCandidate> | null = null;
  const historyCandidates = yield* Effect.cachedWithTTL(
    collectCandidates().pipe(
      Effect.flatMap((result) =>
        DateTime.now.pipe(Effect.map((now) => ({ ...result, scannedAt: DateTime.formatIso(now) }))),
      ),
    ),
    "30 seconds",
  );

  const discoveryMetadata = (file: DiscoveryFile, value: unknown) => {
    const cwd = extractCwd(JSON.stringify(value) ?? "", file.source);
    if (cwd === false) return false;
    const decoded = decodeTranscriptValue(value);
    if (!cwd || Option.isNone(decoded)) return null;
    const record = decoded.value;
    const providerInstanceId = ProviderInstanceId.make(file.providerInstanceId);
    const providerSessionId =
      (file.source === "codex"
        ? record.payload?.id?.trim() || record.payload?.session_id
        : file.source === "claudeAgent"
          ? record.sessionId
          : record.id
      )?.trim() || path.basename(file.filePath, ".jsonl");
    const thread = parseAgentSessionRecords(
      {
        source: file.source,
        providerInstanceId,
        fallbackSessionId: providerSessionId,
        lastActiveAtMs: file.mtimeMs,
      },
      [record],
      file.source === "claudeAgent"
        ? foldClaudeFields(emptyClaudeFields, record)
        : emptyClaudeFields,
      1,
      false,
    );
    return {
      ...file,
      providerInstanceId,
      providerSessionId,
      cwd,
      title: thread?.title === "Imported thread" ? undefined : thread?.title,
      record: {
        type: record.type,
        id: record.id,
        cwd: record.cwd,
        sessionId: record.sessionId,
        payload: record.payload
          ? {
              id: record.payload.id,
              session_id: record.payload.session_id,
              cwd: record.payload.cwd,
            }
          : undefined,
      },
    };
  };
  type DiscoveredSession = Exclude<ReturnType<typeof discoveryMetadata>, false | null>;
  const asCandidate = (entry: DiscoveredSession): RawCandidate => ({
    cwd: entry.cwd,
    source: entry.source,
    providerInstanceId: entry.providerInstanceId,
    homePath: entry.homePath,
    threadCount: 1,
    lastActiveAtMs: entry.mtimeMs,
    transcripts: [
      {
        filePath: entry.filePath,
        mtimeMs: entry.mtimeMs,
        providerSessionId: entry.providerSessionId,
        title: entry.title,
        discovered: { identity: entry, record: entry.record },
      },
    ],
  });
  const discoveries = new Map<
    string,
    {
      index: ReturnType<typeof createSessionDiscovery<DiscoveredSession>>;
      directory: string;
      scannedAt: string;
      step: number;
      complete: boolean;
      homes: string;
      candidates: Array<RawCandidate>;
    }
  >();
  const discardDiscovery = Effect.fn("AgentSessionScanner.discardDiscovery")(function* (
    token: string,
  ) {
    const state = discoveries.get(token);
    if (!state) return;
    discoveries.delete(token);
    yield* Effect.tryPromise(() => state.index.close()).pipe(Effect.ignore);
    yield* fileSystem.remove(state.directory, { recursive: true }).pipe(Effect.ignore);
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach(discoveries.keys(), discardDiscovery, { discard: true }),
  );
  const discoveryLock = yield* Semaphore.make(1);

  const listSessions = Effect.fn("AgentSessionScanner.listSessions")(
    function* (
      input: AgentSessionHistoryInput,
      cachedContext?: ReadonlyMap<string, Extract<AgentSessionPreviewResult, { status: "ready" }>>,
    ) {
      const initial = yield* historyCandidates;
      let { candidates, truncated, scannedAt } = initial;
      let discoveryToken: string | undefined;
      let discoveryAfter: AgentSessionHistoryInput["cursor"];
      const issued = input.cursor?.discovery;
      const homes = yield* encodeDiscoveryHomes(initial.discoveryHomes);
      if (initial.truncated || issued !== undefined) {
        const [requestedToken, requestedStep] = issued?.split(":") ?? [];
        let token = requestedToken;
        let state = token === undefined ? undefined : discoveries.get(token);
        if (
          issued !== undefined &&
          (!state ||
            state.homes !== homes ||
            issued !== `${requestedToken}:${requestedStep}` ||
            !/^(0|[1-9][0-9]*|done)$/.test(requestedStep ?? ""))
        )
          return yield* new AgentSessionScanError({
            operation: "discovery-cursor",
            cause: "Discovery expired. Return to Newest and retry.",
          });
        if (!state) {
          const existing = Array.from(discoveries).find(
            ([, entry]) =>
              entry.homes === homes && (!entry.complete || entry.scannedAt === initial.scannedAt),
          );
          if (existing) {
            [token, state] = existing;
          } else {
            token = NodeCrypto.randomUUID();
            const directory = yield* fileSystem.makeTempDirectory({
              prefix: "t3-history-discovery-",
            });
            const knownTitles = new Map(
              initial.candidates.flatMap((candidate) =>
                candidate.transcripts.map(
                  (transcript) => [transcript.filePath, transcript] as const,
                ),
              ),
            );
            const index = yield* Effect.try(() =>
              createSessionDiscovery(
                path.join(directory, "sessions.sqlite"),
                initial.discoveryHomes,
                (jsonPath) =>
                  selectTranscriptPath(jsonPath) ||
                  (jsonPath[0] === "payload" && jsonPath[1] === "source"),
                (file, value) => {
                  const entry = discoveryMetadata(file, value);
                  if (!entry) return entry;
                  const known = knownTitles.get(file.filePath);
                  return {
                    ...entry,
                    title:
                      known?.mtimeMs === file.mtimeMs ? (known.title ?? entry.title) : entry.title,
                  };
                },
              ),
            ).pipe(
              Effect.tapError(() =>
                fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore),
              ),
            );
            state = {
              index,
              directory,
              scannedAt: initial.scannedAt,
              step: 0,
              complete: false,
              homes,
              candidates: initial.candidates,
            };
            discoveries.set(token, state);
            if (discoveries.size > 4) yield* discardDiscovery(discoveries.keys().next().value!);
          }
        }
        if (token === undefined)
          return yield* new AgentSessionScanError({
            operation: "discovery-cursor",
            cause: "Missing discovery",
          });
        const activeToken = token;
        const step = requestedStep === undefined ? 0 : Number(requestedStep);
        if (requestedStep !== "done" && !(requestedStep === undefined && state.complete)) {
          if (!Number.isSafeInteger(step) || step > state.step)
            return yield* new AgentSessionScanError({
              operation: "discovery-cursor",
              cause: "Invalid discovery step",
            });
          if (step === state.step && !state.complete) {
            state.complete = yield* Effect.tryPromise(() => state.index.advance()).pipe(
              Effect.uninterruptible,
              Effect.tapError(() => discardDiscovery(activeToken)),
              Effect.mapError(
                (cause) => new AgentSessionScanError({ operation: "discover-sessions", cause }),
              ),
            );
            state.step++;
          }
          if (!state.complete || step < state.step - 1) {
            candidates = state.candidates;
            truncated = true;
            discoveryAfter = {
              updatedAt: state.scannedAt,
              providerInstanceId: ProviderInstanceId.make("discovery"),
              providerSessionId: "discovery",
              discovery: `${token}:${step + 1}`,
            };
          }
        } else if (!state.complete) {
          return yield* new AgentSessionScanError({
            operation: "discovery-cursor",
            cause: "Discovery is not complete",
          });
        }
        discoveries.delete(token);
        discoveries.set(token, state);
        scannedAt = state.scannedAt;
        if (discoveryAfter === undefined) {
          discoveryToken = token;
          const rows = yield* Effect.try(() =>
            state.index.page(requestedStep === "done" ? input.cursor : undefined),
          );
          const selected = rows.slice(0, 500);
          const last = selected.at(-1);
          if (rows.length > 500 && last)
            discoveryAfter = {
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(last.mtimeMs)),
              providerInstanceId: last.providerInstanceId,
              providerSessionId: last.providerSessionId,
              discovery: `${token}:done`,
            };
          candidates = selected.map(asCandidate);
          truncated = false;
        }
      }
      cachedCandidates = candidates;
      const selectedRoot =
        input.workspaceRoot === undefined
          ? null
          : yield* directoryIdentity(path.resolve(expandHomePath(input.workspaceRoot, homeDir)));
      const sessions: Array<AgentSessionHistoryResult["sessions"][number]> = [];
      const searchContext = new Map<string, string>();
      const seen = new Set<string>();
      const namesByHome = new Map<string, ReadonlyMap<string, string>>();
      for (const candidate of candidates) {
        const workspaceRoot = expandHomePath(candidate.cwd.trim(), homeDir);
        if (!path.isAbsolute(workspaceRoot)) continue;
        if (selectedRoot !== null && (yield* directoryIdentity(workspaceRoot)) !== selectedRoot)
          continue;
        const names =
          candidate.source === "codex"
            ? (namesByHome.get(candidate.homePath) ??
              (yield* readCodexThreadNames(candidate.homePath)))
            : null;
        if (names !== null) namesByHome.set(candidate.homePath, names);
        for (const transcript of candidate.transcripts) {
          if (transcript.mtimeMs === null) continue;
          const key = `${candidate.providerInstanceId}\0${transcript.providerSessionId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const cached = cachedContext?.get(`${key}\0${workspaceRoot}`);
          const stats =
            cached === undefined ? Option.none() : yield* statOption(transcript.filePath);
          const context =
            cached !== undefined &&
            Option.isSome(stats) &&
            transcriptRevision(transcriptIdentity(transcript.filePath, stats.value)) ===
              cached.revision
              ? cached
              : undefined;
          if (context !== undefined)
            searchContext.set(key, context.messages.map((message) => message.text).join("\n"));
          sessions.push({
            recentExcerpt: context?.messages.at(-1)?.text.slice(0, 300),
            recap: context?.recap,
            provider: candidate.source,
            providerInstanceId: candidate.providerInstanceId,
            providerSessionId: transcript.providerSessionId,
            workspaceRoot,
            title:
              names?.get(transcript.providerSessionId) ??
              transcript.title ??
              `${candidate.source === "claudeAgent" ? "Claude" : candidate.source === "codex" ? "Codex" : "Pi"} conversation · ${transcript.providerSessionId.slice(0, 8)}`,
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(transcript.mtimeMs)),
          });
        }
      }
      const compare = (
        left: NonNullable<AgentSessionHistoryResult["nextCursor"]>,
        right: NonNullable<AgentSessionHistoryResult["nextCursor"]>,
      ) => {
        const textOrder = (left: string, right: string) =>
          discoveryToken === undefined
            ? left.localeCompare(right)
            : left === right
              ? 0
              : left < right
                ? -1
                : 1;
        return (
          right.updatedAt.localeCompare(left.updatedAt) ||
          textOrder(left.providerInstanceId, right.providerInstanceId) ||
          textOrder(left.providerSessionId, right.providerSessionId)
        );
      };
      sessions.sort(compare);
      const cursor =
        input.cursor?.discovery && !input.cursor.discovery.endsWith(":done")
          ? undefined
          : input.cursor;
      const query = input.query?.trim().toLowerCase() ?? "";
      const after = sessions.filter(
        (session) =>
          (cursor === undefined || compare(session, cursor) > 0) &&
          `${session.title} ${session.workspaceRoot} ${session.provider} ${searchContext.get(`${session.providerInstanceId}\0${session.providerSessionId}`) ?? ""} ${session.recap?.summary ?? ""} ${session.recap?.nextAction ?? ""}`
            .toLowerCase()
            .includes(query),
      );
      const limit = input.limit ?? 25;
      const page = after.slice(0, limit);
      const last = page.at(-1);
      return {
        sessions: page,
        nextCursor:
          // Partial results are a snapshot; advance discovery before paging its final ordering.
          truncated && discoveryAfter !== undefined
            ? discoveryAfter
            : after.length > limit && last !== undefined
              ? {
                  updatedAt: last.updatedAt,
                  providerInstanceId: last.providerInstanceId,
                  providerSessionId: last.providerSessionId,
                  ...(discoveryToken === undefined ? {} : { discovery: `${discoveryToken}:done` }),
                }
              : (discoveryAfter ?? null),
        scannedAt,
        truncated,
      } satisfies AgentSessionHistoryResult;
    },
    discoveryLock.withPermits(1),
    Effect.mapError((cause) =>
      isScanError(cause)
        ? cause
        : new AgentSessionScanError({ operation: "discover-sessions", cause }),
    ),
  );

  const scan: AgentSessionScanner["Service"]["scan"] = Effect.gen(function* () {
    const { candidates: raw, truncated } = yield* collectCandidates();
    cachedCandidates = raw;

    const merged = new Map<
      string,
      {
        path: string;
        sources: Array<AgentSessionSource>;
        threadCount: number;
        lastActiveAtMs: number | null;
        git: AgentSessionProjectGit | null;
      }
    >();
    // Resolve every candidate directory first so one batch reads all git identities.
    const directories = new Map<string, Option.Option<FileSystem.File.Info>>();
    for (const candidate of raw) {
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if (directories.has(resolved) || isExcludedProjectPath(resolved)) continue;
      const stats = yield* statOption(resolved);
      if (Option.isNone(stats) || stats.value.type !== "Directory") {
        directories.set(resolved, Option.none());
        continue;
      }
      const realPath = yield* fileSystem
        .realPath(resolved)
        .pipe(Effect.orElseSucceed(() => resolved));
      // Symlinks can disguise excluded worktree paths; re-check their targets.
      directories.set(resolved, isExcludedProjectPath(realPath) ? Option.none() : stats);
    }
    const directoryGitIdentities = yield* readGitIdentities(
      Array.from(directories).flatMap(([directory, stats]) =>
        Option.isSome(stats) ? [directory] : [],
      ),
    );

    const directoryKeys = new Map<string, string>();
    const gitIdentities = new Map<string, AgentSessionProjectGit | null>();

    for (const candidate of raw) {
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      const stats = directories.get(resolved);
      if (stats === undefined || Option.isNone(stats)) continue;
      let key = directoryKeys.get(resolved);
      if (key === undefined) {
        const gitIdentity = directoryGitIdentities.get(resolved);
        if (gitIdentity === undefined || gitIdentity._tag === "Worktree") {
          key = "";
        } else {
          key = yield* directoryIdentity(resolved, stats.value);
          gitIdentities.set(key, gitIdentity._tag === "Repository" ? gitIdentity.git : null);
        }
        directoryKeys.set(resolved, key);
      }
      if (key === "") continue;

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          path: resolved,
          sources: [candidate.source],
          threadCount: candidate.threadCount,
          lastActiveAtMs: candidate.lastActiveAtMs,
          git: gitIdentities.get(key) ?? null,
        });
        continue;
      }
      if (!existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
      }
      existing.threadCount += candidate.threadCount;
      existing.lastActiveAtMs =
        existing.lastActiveAtMs === null || candidate.lastActiveAtMs === null
          ? (existing.lastActiveAtMs ?? candidate.lastActiveAtMs)
          : Math.max(existing.lastActiveAtMs, candidate.lastActiveAtMs);
    }

    // Resolve persisted roots too; transcripts may use different symlinks to the same directory.
    const importedProjects = yield* projectStore
      .listShells()
      .pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      );
    const importedProjectsByRoot = new Map<string, (typeof importedProjects)[number]>();
    for (const project of importedProjects) {
      const projectRoot = path.resolve(expandHomePath(project.workspaceRoot, homeDir));
      importedProjectsByRoot.set(normalizeProjectPathForComparison(projectRoot), project);
      importedProjectsByRoot.set(yield* directoryIdentity(projectRoot), project);
    }

    const candidates: Array<AgentSessionProjectCandidate> = [];
    for (const [key, entry] of merged.entries()) {
      const importedProject =
        importedProjectsByRoot.get(normalizeProjectPathForComparison(entry.path)) ??
        importedProjectsByRoot.get(key);
      const candidatePath = importedProject?.workspaceRoot ?? entry.path;
      candidates.push({
        path: candidatePath,
        title: path.basename(candidatePath) || candidatePath,
        ...(importedProject === undefined ? {} : { projectId: importedProject.id }),
        sources: entry.sources,
        threadCount: entry.threadCount,
        lastActiveAt:
          entry.lastActiveAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(entry.lastActiveAtMs)),
        alreadyImported: importedProject !== undefined,
        git: entry.git,
      });
    }

    candidates.sort((left, right) => {
      if (left.lastActiveAt === right.lastActiveAt) return left.path.localeCompare(right.path);
      if (left.lastActiveAt === null) return 1;
      if (right.lastActiveAt === null) return -1;
      return right.lastActiveAt.localeCompare(left.lastActiveAt);
    });

    return {
      candidates,
      scannedAt: DateTime.formatIso(yield* DateTime.now),
      ...(truncated ? { truncated: true } : {}),
    };
  });

  const prepareRecentThreads = Effect.fn("AgentSessionScanner.prepareRecentThreads")(function* (
    workspaceRoot: string,
    completedSources: ReadonlyArray<AgentSessionImportSource>,
    session?: AgentSessionImportInput["session"],
    preview = false,
    cursor?: AgentSessionPreviewInput["cursor"],
  ) {
    const root = path.resolve(expandHomePath(workspaceRoot, homeDir));
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
    if (session === undefined && (isExcludedProjectPath(root) || isExcludedProjectPath(realRoot)))
      return Stream.empty;
    const rootIdentity = yield* directoryIdentity(root);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const cutoffMs = nowMs - RECENT_THREAD_WINDOW_MS;

    const collected = session !== undefined && !preview ? yield* collectCandidates() : undefined;
    let candidates =
      collected?.candidates ?? cachedCandidates ?? (yield* collectCandidates()).candidates;
    cachedCandidates = candidates;
    if (session !== undefined && discoveries.size > 0) {
      const homes = yield* encodeDiscoveryHomes(
        (collected ?? (yield* historyCandidates)).discoveryHomes,
      ).pipe(
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "discover-sessions", cause }),
        ),
      );
      for (const state of Array.from(discoveries.values()).reverse()) {
        if (state.homes !== homes) continue;
        const entry = yield* Effect.try(() =>
          state.index.find(session.providerInstanceId, session.providerSessionId),
        ).pipe(
          Effect.mapError(
            (cause) => new AgentSessionScanError({ operation: "discover-sessions", cause }),
          ),
        );
        if (entry) {
          candidates = [asCandidate(entry)].concat(candidates);
          break;
        }
      }
    }

    const eligibleTranscripts: Array<{
      readonly candidate: RawCandidate;
      readonly transcript: RawCandidate["transcripts"][number] & { readonly mtimeMs: number };
    }> = [];
    for (const candidate of candidates) {
      if (session !== undefined && candidate.providerInstanceId !== session.providerInstanceId)
        continue;
      const expanded = expandHomePath(candidate.cwd.trim(), homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if ((yield* directoryIdentity(resolved)) !== rootIdentity) continue;

      for (const transcript of candidate.transcripts) {
        if (session !== undefined && transcript.providerSessionId !== session.providerSessionId)
          continue;
        if (
          transcript.mtimeMs === null ||
          (session === undefined && transcript.mtimeMs < cutoffMs) ||
          transcript.mtimeMs > nowMs
        ) {
          continue;
        }
        eligibleTranscripts.push({
          candidate,
          transcript: { ...transcript, mtimeMs: transcript.mtimeMs },
        });
      }
    }

    eligibleTranscripts.sort((left, right) => {
      if (left.transcript.mtimeMs !== right.transcript.mtimeMs) {
        return right.transcript.mtimeMs - left.transcript.mtimeMs;
      }
      return left.transcript.filePath.localeCompare(right.transcript.filePath);
    });

    const completedByFile = Map.groupBy(
      completedSources,
      (source) => `${source.providerInstanceId}\0${source.filePath}`,
    );
    const importedSessions = new Set<string>();
    const codexThreadNamesByHome = new Map<string, ReadonlyMap<string, string>>();
    let bytesRemaining = MAX_IMPORT_BYTES;
    let transcriptsRemaining = MAX_IMPORT_TRANSCRIPTS;
    return Stream.fromIteratorSucceed(eligibleTranscripts.values(), 1).pipe(
      Stream.mapEffect(({ candidate, transcript }) =>
        Effect.gen(function* () {
          const completed = completedByFile.get(
            `${candidate.providerInstanceId}\0${transcript.filePath}`,
          );
          if (completed === undefined && (transcriptsRemaining === 0 || bytesRemaining === 0)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const stats = yield* statOption(transcript.filePath);
          if (Option.isNone(stats) || stats.value.type !== "File") {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const identity = transcriptIdentity(transcript.filePath, stats.value);
          if (preview && session && cursor?.scan) {
            const indexed = yield* continuePreviewIndex(identity, session, cursor).pipe(
              Effect.onError(() => discardPreviewIndex(cursor.scan!)),
              Effect.orElseSucceed(() => undefined),
            );
            return indexed
              ? Option.some<AgentSessionRecentThread>({
                  _tag: "Importable",
                  source: indexed.source,
                  thread: indexed.thread,
                  previewResult: indexed.result,
                })
              : Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const completedSource = completed?.find(
            (source) =>
              source.provider === candidate.source && sameTranscriptIdentity(source, identity),
          );
          if (completedSource !== undefined) {
            const sessionKey = `${completedSource.providerInstanceId}\0${completedSource.providerSessionId}`;
            if (importedSessions.has(sessionKey)) return Option.none<AgentSessionRecentThread>();
            importedSessions.add(sessionKey);
            return Option.some<AgentSessionRecentThread>({
              _tag: "AlreadyImported",
              source: completedSource,
            });
          }
          if (
            transcriptsRemaining === 0 ||
            (!preview && identity.size > MAX_IMPORTED_TRANSCRIPT_BYTES) ||
            (!preview && identity.size > bytesRemaining)
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          transcriptsRemaining -= 1;
          bytesRemaining -= identity.size;
          let snapshot = yield* preview &&
          (identity.size > MAX_PREVIEW_BYTES || candidate.source !== "pi")
            ? readPreviewWindow(
                transcript.filePath,
                identity,
                candidate.source,
                cursor?.revision === transcriptRevision(identity) ? cursor.byteOffset : undefined,
                transcript.discovered,
              )
            : readTranscript(transcript.filePath, identity, candidate.source);
          if (snapshot === null && preview && candidate.source === "pi")
            snapshot = yield* readPreviewWindow(
              transcript.filePath,
              identity,
              candidate.source,
              undefined,
              transcript.discovered,
            );
          if (snapshot === null) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }

          if (Option.isNone(snapshot.cwd)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          const expandedCwd = expandHomePath(snapshot.cwd.value.trim(), homeDir);
          if (
            !path.isAbsolute(expandedCwd) ||
            (yield* directoryIdentity(path.resolve(expandedCwd))) !== rootIdentity
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }

          const parsedThread = parseAgentSessionRecords(
            {
              source: candidate.source,
              providerInstanceId: candidate.providerInstanceId,
              fallbackSessionId: path.basename(transcript.filePath, ".jsonl"),
              lastActiveAtMs: transcript.mtimeMs,
            },
            snapshot.records,
            snapshot.claudeFields,
            preview ? MAX_IMPORT_RECORDS : MAX_IMPORTED_MESSAGES,
            !preview,
          );
          if (
            parsedThread === null ||
            (session !== undefined && parsedThread.providerSessionId !== session.providerSessionId)
          ) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Skipped" });
          }
          let savedTitle =
            preview && identity.size > MAX_PREVIEW_BYTES ? transcript.title : undefined;
          if (candidate.source === "codex") {
            const names =
              codexThreadNamesByHome.get(candidate.homePath) ??
              (yield* readCodexThreadNames(candidate.homePath));
            codexThreadNamesByHome.set(candidate.homePath, names);
            savedTitle = names.get(parsedThread.providerSessionId);
          }

          const source: AgentSessionImportSource = {
            ...identity,
            provider: parsedThread.source,
            providerInstanceId: parsedThread.providerInstanceId,
            providerSessionId: parsedThread.providerSessionId,
          };
          const sessionKey = `${parsedThread.providerInstanceId}\0${parsedThread.providerSessionId}`;
          if (importedSessions.has(sessionKey)) {
            return Option.some<AgentSessionRecentThread>({ _tag: "Duplicate", source });
          }
          importedSessions.add(sessionKey);
          if (preview && cursor && cursor.revision !== transcriptRevision(identity))
            return Option.some<AgentSessionRecentThread>({
              _tag: "Importable",
              source,
              thread: parsedThread,
              previewResult: { status: "unavailable", reason: "changed" },
            });
          const needsIndex =
            preview &&
            ((transcript.discovered !== undefined && cursor === undefined) ||
              (cursor?.before === 0 && cursor.byteOffset !== undefined) ||
              (candidate.source === "pi" && snapshot.olderByteOffset > 0) ||
              (candidate.source === "codex" &&
                snapshot.olderByteOffset > 0 &&
                snapshot.records.some(
                  (record) => record.type === "response_item" && record.payload?.role === "user",
                )));
          const previewResult = needsIndex
            ? yield* startPreviewIndex(
                identity,
                source,
                parsedThread,
                cursor?.byteOffset ?? identity.size,
                snapshot.records[0]!,
              ).pipe(
                Effect.orElseSucceed(
                  () => ({ status: "unavailable", reason: "unreadable" }) as const,
                ),
              )
            : undefined;
          return Option.some<AgentSessionRecentThread>({
            _tag: "Importable",
            ...(previewResult === undefined ? {} : { previewResult }),
            olderByteOffset: snapshot.olderByteOffset,
            thread:
              savedTitle === undefined ? parsedThread : { ...parsedThread, title: savedTitle },
            source,
          });
        }).pipe(importReadLock.withPermits(1)),
      ),
      Stream.map(Option.toArray),
      Stream.flattenIterable,
    );
  });

  const recentThreads: AgentSessionScanner["Service"]["recentThreads"] = (
    workspaceRoot,
    completedSources = [],
    session,
  ) => Stream.unwrap(prepareRecentThreads(workspaceRoot, completedSources, session));

  const previewSession = Effect.fn("AgentSessionScanner.previewSession")(function* (
    input: AgentSessionPreviewInput,
  ) {
    const stream = yield* prepareRecentThreads(
      input.workspaceRoot,
      [],
      input.session,
      true,
      input.cursor,
    );
    const outcomes = yield* stream.pipe(Stream.take(1), Stream.runCollect);
    const outcome = outcomes[0];
    if (outcome?._tag !== "Importable")
      return { status: "unavailable", reason: "unreadable" } as const;
    if (outcome.previewResult) return outcome.previewResult;
    const { source, thread } = outcome;
    const revision = transcriptRevision(source);
    if (input.cursor !== undefined && input.cursor.revision !== revision) {
      return { status: "unavailable", reason: "changed" } as const;
    }
    if (input.cursor?.before === 0 && input.cursor.byteOffset === undefined)
      return { status: "unavailable", reason: "unreadable" } as const;
    const end =
      input.cursor?.byteOffset !== undefined && input.cursor.before === 0
        ? thread.messages.length
        : (input.cursor?.before ?? thread.messages.length);
    if (end > thread.messages.length)
      return { status: "unavailable", reason: "unreadable" } as const;
    if (!Number.isSafeInteger(end) || end < 0)
      return { status: "unavailable", reason: "unreadable" } as const;
    const messages: Array<
      Extract<AgentSessionPreviewResult, { status: "ready" }>["messages"][number]
    > = [];
    let before = end;
    let textBefore = input.cursor?.textBefore;
    if (
      textBefore !== undefined &&
      (!Number.isSafeInteger(textBefore) || textBefore <= 0 || end === 0)
    )
      return { status: "unavailable", reason: "unreadable" } as const;
    while (before > 0 && messages.length < 4) {
      const { sourceOffset, ...message } = thread.messages[before - 1]!;
      let text = message.text;
      const marker = "\n\nUser message:\n";
      const boundary = text.indexOf(marker);
      // Strip only an unambiguous inline handoff; raw import history keeps the full prompt.
      if (
        message.role === "user" &&
        text.startsWith("Context handoff (") &&
        boundary !== -1 &&
        boundary === text.lastIndexOf(marker)
      ) {
        text = text.slice(boundary + marker.length);
      }
      const textEnd = textBefore ?? text.length;
      if (
        textEnd > text.length ||
        (textEnd < text.length && /[\uDC00-\uDFFF]/.test(text[textEnd]!))
      )
        return { status: "unavailable", reason: "unreadable" } as const;
      let textStart = Math.max(0, textEnd - 4000);
      if (textStart > 0 && /[\uDC00-\uDFFF]/.test(text[textStart]!)) textStart += 1;
      messages.unshift({
        ...message,
        id: `${source.providerInstanceId}:${source.providerSessionId}:${sourceOffset ?? before - 1}${text.length > 4000 ? `:${textStart}` : ""}`,
        text: text.slice(textStart, textEnd),
        truncated: textStart > 0 || textEnd < text.length,
      });
      textBefore = textStart || undefined;
      if (textStart > 0) break;
      before -= 1;
    }
    return {
      status: "ready",
      revision,
      title: thread.title,
      model: thread.model,
      boundedWindow: source.size > MAX_PREVIEW_BYTES,
      messages,
      nextCursor:
        before > 0
          ? {
              revision,
              before,
              ...(input.cursor?.byteOffset === undefined
                ? {}
                : { byteOffset: input.cursor.byteOffset }),
              ...(textBefore === undefined ? {} : { textBefore }),
            }
          : outcome.olderByteOffset
            ? { revision, before: 0, byteOffset: outcome.olderByteOffset }
            : null,
    } satisfies AgentSessionPreviewResult;
  });

  return AgentSessionScanner.of({ scan, recentThreads, listSessions, previewSession });
});

export const layer = Layer.effect(AgentSessionScanner, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
