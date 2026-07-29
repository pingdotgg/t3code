/**
 * ClaudeSessionHistory — reads Claude Code's on-disk session transcripts to
 * list resumable sessions for a given workspace root, and binds a picked
 * session to a thread's provider session directory entry. Powers the
 * `server.listClaudeResumableSessions` RPC and the bootstrap-time resume
 * binding in `ws.ts`'s `dispatchBootstrapTurnStart` (the "resume a previous
 * Claude Code session" picker end to end). Claude-only: no other provider's
 * on-disk transcript format is understood here.
 *
 * Claude Code stores one directory per working directory under
 * `<config dir>/projects/`, named by replacing every non-alphanumeric
 * character in the absolute cwd with `-` (so `/Users/m/Documents/t3` becomes
 * `-Users-m-Documents-t3`). Each session is a `<sessionId>.jsonl` file inside
 * that directory — a stream of JSON records (`user`/`assistant` messages plus
 * assorted metadata lines) that Claude Code itself replays for `--resume`.
 *
 * `getInstance`/`upsert` (via `ProviderInstanceRegistry` /
 * `ProviderSessionDirectory`) are required here, inside this service, rather
 * than being `yield*`'d directly in `ws.ts` — `ws.ts`'s own top-level R is
 * threaded through several hand-composed layer stacks (server tests, `bin.ts`)
 * that don't otherwise know about provider internals, so keeping this
 * dependency contained to a single already-wired service (this one) avoids
 * leaking it into all of those call sites. `ProviderInstanceRegistry` (not
 * `ProviderAdapterRegistry`, which `server.ts` keeps private to
 * `ProviderServiceLive`'s own construction) is the instance→driver-kind
 * lookup that's actually exposed by the composed runtime.
 *
 * @module provider/Layers/ClaudeSessionHistory
 */
import {
  ClaudeSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerClaudeResumableSession,
  type ServerClaudeResumableSessionMessage,
  type ServerGetClaudeResumableSessionTranscriptInput,
  type ServerGetClaudeResumableSessionTranscriptResult,
  type ServerListClaudeResumableSessionsInput,
  type ServerListClaudeResumableSessionsResult,
  type ServerSetClaudeThreadRemoteControlInput,
  type ServerSetClaudeThreadRemoteControlResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveClaudeConfigDirPath } from "../Drivers/ClaudeSkills.ts";
import { ProviderValidationError } from "../Errors.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import type { ProviderSessionDirectoryWriteError } from "../Services/ProviderSessionDirectory.ts";

const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

const JSONL_EXTENSION = ".jsonl";
const MAX_LABEL_LENGTH = 80;
const MAX_TRANSCRIPT_MESSAGES = 200;
// Every Claude Code session id observed on disk is a UUID (the filename
// stem of `<sessionId>.jsonl`). `sessionId` is caller-controlled input that
// gets interpolated into a filesystem path (`getTranscript`) — validating it
// against this shape before doing anything with it closes off path
// traversal (`../../other-project/secret`) rather than merely resolving to
// a possibly-out-of-bounds path and hoping the caller was honest.
const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidClaudeSessionId(sessionId: string): boolean {
  return CLAUDE_SESSION_ID_PATTERN.test(sessionId);
}

function encodeCwdForClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function truncateLabel(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_LABEL_LENGTH ? `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…` : trimmed;
}

function extractTextFromUserContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        const text = (block as { text: string }).text;
        if (text.trim().length > 0) return text;
      }
    }
  }
  return undefined;
}

/**
 * Concatenates every `type: "text"` block in a message's `content` (string
 * or content-block array), skipping `tool_use`/`tool_result`/`thinking`/
 * image blocks. Used for full transcript import, where an assistant turn
 * may interleave several text blocks around tool calls — unlike
 * `extractTextFromUserContent` (label extraction only, first block wins),
 * this collects all of them so imported history reads coherently.
 */
function extractAllTextBlocks(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const text = (block as { text: string }).text;
      if (text.trim().length > 0) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

interface TranscriptSummary {
  readonly latestTimestampMs: number | undefined;
  readonly label: string | undefined;
  readonly messageCount: number;
}

function summarizeTranscript(raw: string): TranscriptSummary {
  let latestTimestampMs: number | undefined;
  let label: string | undefined;
  let messageCount = 0;

  for (const line of raw.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(trimmedLine);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;

    if (typeof record.timestamp === "string") {
      const ms = Date.parse(record.timestamp);
      if (Number.isFinite(ms) && (latestTimestampMs === undefined || ms > latestTimestampMs)) {
        latestTimestampMs = ms;
      }
    }

    if (type === "user" || type === "assistant") {
      messageCount += 1;
    }

    if (label === undefined && type === "user") {
      const message = record.message;
      const content =
        message && typeof message === "object"
          ? (message as Record<string, unknown>).content
          : undefined;
      const extracted = extractTextFromUserContent(content);
      if (extracted !== undefined) {
        label = truncateLabel(extracted);
      }
    }
  }

  return { latestTimestampMs, label, messageCount };
}

/**
 * Parses a full transcript into flat, chronological, text-only messages for
 * display-only import (see `getTranscript`). Plain (non-Effect) function so
 * its `JSON.parse` calls stay outside any Effect generator.
 */
function parseTranscriptMessages(
  raw: string,
  sessionId: string,
): ServerClaudeResumableSessionMessage[] {
  const messages: ServerClaudeResumableSessionMessage[] = [];

  for (const line of raw.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(trimmedLine);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    if (type !== "user" && type !== "assistant") continue;
    const timestamp = record.timestamp;
    if (typeof timestamp !== "string") continue;

    const message = record.message;
    const content =
      message && typeof message === "object"
        ? (message as Record<string, unknown>).content
        : undefined;
    const text = extractAllTextBlocks(content);
    if (text === undefined) continue;

    const id =
      typeof record.uuid === "string" && record.uuid.length > 0
        ? record.uuid
        : `${sessionId}-${messages.length}`;

    messages.push({ id, role: type, text, createdAt: timestamp });
  }

  messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return messages;
}

export interface ClaudeSessionHistoryBindSessionLaunchOptionsInput {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** Resume a picked on-disk session's model context via `--resume <uuid>`. */
  readonly resumeExternalSessionId?: string;
  /**
   * Start the session with Claude Code's Remote Control (`--remote-control`)
   * enabled, or explicitly disabled. `undefined` leaves whatever was
   * previously bound untouched (e.g. a plain resume-only call).
   */
  readonly remoteControl?: boolean;
}

export class ClaudeSessionHistory extends Context.Service<
  ClaudeSessionHistory,
  {
    readonly list: (
      input: ServerListClaudeResumableSessionsInput,
    ) => Effect.Effect<ServerListClaudeResumableSessionsResult>;
    /**
     * Reads a specific resumable session's on-disk transcript back as a flat,
     * text-only message list, for display-only import into T3's own thread
     * view (see `ResumeSessionDialog.tsx`). These never become real
     * orchestration events/messages.
     */
    readonly getTranscript: (
      input: ServerGetClaudeResumableSessionTranscriptInput,
    ) => Effect.Effect<ServerGetClaudeResumableSessionTranscriptResult>;
    /**
     * Binds thread-creation-time Claude launch choices (resume a picked
     * on-disk session, and/or start with Remote Control enabled) onto a
     * thread's provider session directory entry, so they take effect on the
     * next (first) turn. No-op if neither option is set. Fails if the
     * target provider instance isn't a Claude instance.
     */
    readonly bindSessionLaunchOptions: (
      input: ClaudeSessionHistoryBindSessionLaunchOptionsInput,
    ) => Effect.Effect<void, ProviderValidationError | ProviderSessionDirectoryWriteError>;
    /**
     * Turns Remote Control on/off for an already-created thread. Unlike
     * `bindSessionLaunchOptions` (thread-creation time only), this can run
     * against a thread with an active running session — Remote Control is a
     * `claude` process launch flag, not something a running process can be
     * told to flip live, so this stops the thread's active session (if any)
     * after binding the choice, so it relaunches with the flag applied on
     * its next turn. Best-effort/non-fatal: `applied: false` on a bind
     * failure (e.g. non-Claude instance); a stop failure or no active
     * session never fails the call, since the bind itself already took.
     */
    readonly setThreadRemoteControl: (
      input: ServerSetClaudeThreadRemoteControlInput,
    ) => Effect.Effect<ServerSetClaudeThreadRemoteControlResult>;
  }
>()("t3/provider/Layers/ClaudeSessionHistory") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providerInstanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerSessionDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const providerService = yield* ProviderService;
  const serverSettings = yield* ServerSettingsService;

  // Claude instances can be configured with a custom `homePath` (keeping
  // config/session storage separate per instance), so the config dir must be
  // resolved per instance, not once for the whole process. Falls back to the
  // default `~/.claude` location when the instance is unknown/misconfigured
  // rather than failing the whole listing — best-effort, matching `list`'s
  // other file-not-found handling.
  const resolveConfigDirPathForInstance = Effect.fn("ClaudeSessionHistory.resolveConfigDirPath")(
    function* (input: {
      readonly providerInstanceId: ProviderInstanceId | undefined;
      readonly workspaceRoot: string;
    }) {
      const homePath = yield* Effect.gen(function* () {
        if (input.providerInstanceId === undefined) return "";
        const settings = yield* serverSettings.getSettings;
        const configMap = deriveProviderInstanceConfigMap(settings);
        const entry = configMap[input.providerInstanceId];
        const decoded = yield* decodeClaudeSettings(entry?.config ?? {});
        return decoded.homePath;
      }).pipe(Effect.orElseSucceed(() => ""));
      // `resolveClaudeConfigDirPath` yields its own `Path.Path` requirement;
      // satisfy it from the already-resolved `path` in scope so this stays
      // free of a `Path.Path` requirement of its own (see the `list`/`make`
      // split above — required for `Layer.provideMerge` to fully resolve it).
      // `workspaceRoot` is passed as `cwd`: when `homePath` is unset and a
      // *relative* `CLAUDE_CONFIG_DIR` is set in the environment, it must be
      // resolved the same way the spawned `claude` subprocess itself
      // resolves it — against the workspace cwd, not the server's own cwd.
      return yield* resolveClaudeConfigDirPath({ homePath }, process.env, input.workspaceRoot).pipe(
        Effect.provideService(Path.Path, path),
      );
    },
  );

  const resolveProjectDirPath = Effect.fn("ClaudeSessionHistory.resolveProjectDirPath")(
    function* (input: {
      readonly workspaceRoot: string;
      readonly providerInstanceId?: ProviderInstanceId | undefined;
    }) {
      const configDirPath = yield* resolveConfigDirPathForInstance({
        providerInstanceId: input.providerInstanceId,
        workspaceRoot: input.workspaceRoot,
      });
      return path.join(
        configDirPath,
        "projects",
        encodeCwdForClaudeProjectDir(input.workspaceRoot),
      );
    },
  );

  const list: ClaudeSessionHistory["Service"]["list"] = Effect.fn("ClaudeSessionHistory.list")(
    function* (input) {
      const projectDirPath = yield* resolveProjectDirPath(input);

      const entries = yield* fileSystem
        .readDirectory(projectDirPath)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

      const sessions = yield* Effect.forEach(
        entries.filter((entry) => entry.endsWith(JSONL_EXTENSION)),
        (entry) =>
          Effect.gen(function* () {
            const sessionId = entry.slice(0, -JSONL_EXTENSION.length);
            const filePath = path.join(projectDirPath, entry);
            const raw = yield* fileSystem
              .readFileString(filePath)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (raw === undefined) return undefined;

            const summary = summarizeTranscript(raw);
            const lastActiveAtMs =
              summary.latestTimestampMs ??
              (yield* fileSystem.stat(filePath).pipe(
                Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
                Effect.orElseSucceed(() => undefined),
              ));
            if (lastActiveAtMs === undefined || summary.messageCount === 0) return undefined;

            return {
              sessionId,
              cwd: input.workspaceRoot,
              label: summary.label ?? null,
              lastActiveAt: DateTime.formatIso(DateTime.makeUnsafe(lastActiveAtMs)),
              messageCount: summary.messageCount,
            } satisfies ServerClaudeResumableSession;
          }),
        { concurrency: 8 },
      );

      const resolvedSessions = sessions.filter(
        (session): session is ServerClaudeResumableSession => session !== undefined,
      );
      resolvedSessions.sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));

      return { sessions: resolvedSessions };
    },
  );

  const getTranscript: ClaudeSessionHistory["Service"]["getTranscript"] = Effect.fn(
    "ClaudeSessionHistory.getTranscript",
  )(function* (input) {
    // Best-effort/display-only endpoint (see class doc), so an invalid
    // sessionId — most importantly one crafted to escape `projectDirPath`
    // via `../` traversal segments — degrades to "no history to show"
    // rather than a hard error, matching this file's other not-found
    // handling. The validation itself is still load-bearing: it's what
    // stops `path.join` below from ever being handed a value that resolves
    // outside `projectDirPath`.
    if (!isValidClaudeSessionId(input.sessionId)) {
      return { messages: [] };
    }
    const projectDirPath = yield* resolveProjectDirPath(input);
    const filePath = path.join(projectDirPath, `${input.sessionId}${JSONL_EXTENSION}`);
    const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));

    const messages = parseTranscriptMessages(raw, input.sessionId);
    const trimmedMessages =
      messages.length > MAX_TRANSCRIPT_MESSAGES
        ? messages.slice(messages.length - MAX_TRANSCRIPT_MESSAGES)
        : messages;
    return { messages: trimmedMessages };
  });

  const bindSessionLaunchOptions: ClaudeSessionHistory["Service"]["bindSessionLaunchOptions"] =
    Effect.fn("ClaudeSessionHistory.bindSessionLaunchOptions")(function* (input) {
      if (input.resumeExternalSessionId === undefined && input.remoteControl === undefined) {
        return;
      }
      if (
        input.resumeExternalSessionId !== undefined &&
        !isValidClaudeSessionId(input.resumeExternalSessionId)
      ) {
        return yield* new ProviderValidationError({
          operation: "ClaudeSessionHistory.bindSessionLaunchOptions",
          issue: `resumeExternalSessionId must be a Claude session UUID; received '${input.resumeExternalSessionId}'.`,
        });
      }
      const instance = yield* providerInstanceRegistry.getInstance(input.providerInstanceId);
      if (!instance) {
        return yield* new ProviderValidationError({
          operation: "ClaudeSessionHistory.bindSessionLaunchOptions",
          issue: `Provider instance '${input.providerInstanceId}' is not configured.`,
        });
      }
      if (instance.driverKind !== CLAUDE_PROVIDER) {
        return yield* new ProviderValidationError({
          operation: "ClaudeSessionHistory.bindSessionLaunchOptions",
          issue: `Resume/Remote Control are only supported for Claude Code provider instances; '${input.providerInstanceId}' is a '${instance.driverKind}' instance.`,
        });
      }
      // Merge onto whatever's already bound (rather than replacing
      // wholesale) — this can now be called on a thread that already has a
      // `resume` cursor from a prior turn (e.g. toggling Remote Control on
      // an existing, already-running thread), and clobbering that would
      // strand the thread's actual Claude session continuity.
      const existingBinding = yield* providerSessionDirectory.getBinding(input.threadId);
      const existingResumeCursor = Option.getOrUndefined(existingBinding)?.resumeCursor;
      const existingResumeCursorFields =
        existingResumeCursor !== null &&
        typeof existingResumeCursor === "object" &&
        existingResumeCursor !== undefined
          ? (existingResumeCursor as Record<string, unknown>)
          : {};
      yield* providerSessionDirectory.upsert({
        threadId: input.threadId,
        provider: instance.driverKind,
        providerInstanceId: input.providerInstanceId,
        resumeCursor: {
          ...existingResumeCursorFields,
          ...(input.resumeExternalSessionId !== undefined
            ? { resume: input.resumeExternalSessionId }
            : {}),
          ...(input.remoteControl !== undefined ? { remoteControl: input.remoteControl } : {}),
        },
      });
    });

  const setThreadRemoteControl: ClaudeSessionHistory["Service"]["setThreadRemoteControl"] =
    Effect.fn("ClaudeSessionHistory.setThreadRemoteControl")(function* (input) {
      const bindResult = yield* bindSessionLaunchOptions({
        threadId: input.threadId,
        providerInstanceId: input.providerInstanceId,
        remoteControl: input.enabled,
      }).pipe(Effect.result);
      if (bindResult._tag === "Failure") {
        return { applied: false };
      }
      yield* providerService
        .stopSession({ threadId: input.threadId })
        .pipe(Effect.catch(() => Effect.void));
      return { applied: true };
    });

  return ClaudeSessionHistory.of({
    list,
    getTranscript,
    bindSessionLaunchOptions,
    setThreadRemoteControl,
  });
});

export const layer = Layer.effect(ClaudeSessionHistory, make);
