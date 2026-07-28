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
  type ServerListClaudeResumableSessionsInput,
  type ServerListClaudeResumableSessionsResult,
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
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import type { ProviderSessionDirectoryWriteError } from "../Services/ProviderSessionDirectory.ts";

const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

const JSONL_EXTENSION = ".jsonl";
const MAX_LABEL_LENGTH = 80;

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

export interface ClaudeSessionHistoryBindResumeSessionInput {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly resumeExternalSessionId: string;
}

export class ClaudeSessionHistory extends Context.Service<
  ClaudeSessionHistory,
  {
    readonly list: (
      input: ServerListClaudeResumableSessionsInput,
    ) => Effect.Effect<ServerListClaudeResumableSessionsResult>;
    /**
     * Binds a picked on-disk Claude session to a thread's provider session
     * directory entry, so the next turn resumes it via `--resume <uuid>`.
     * Fails if the target provider instance isn't a Claude instance.
     */
    readonly bindResumeSession: (
      input: ClaudeSessionHistoryBindResumeSessionInput,
    ) => Effect.Effect<void, ProviderValidationError | ProviderSessionDirectoryWriteError>;
  }
>()("t3/provider/Layers/ClaudeSessionHistory") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providerInstanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerSessionDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const serverSettings = yield* ServerSettingsService;

  // Claude instances can be configured with a custom `homePath` (keeping
  // config/session storage separate per instance), so the config dir must be
  // resolved per instance, not once for the whole process. Falls back to the
  // default `~/.claude` location when the instance is unknown/misconfigured
  // rather than failing the whole listing — best-effort, matching `list`'s
  // other file-not-found handling.
  const resolveConfigDirPathForInstance = Effect.fn("ClaudeSessionHistory.resolveConfigDirPath")(
    function* (providerInstanceId: ProviderInstanceId | undefined) {
      const homePath = yield* Effect.gen(function* () {
        if (providerInstanceId === undefined) return "";
        const settings = yield* serverSettings.getSettings;
        const configMap = deriveProviderInstanceConfigMap(settings);
        const entry = configMap[providerInstanceId];
        const decoded = yield* decodeClaudeSettings(entry?.config ?? {});
        return decoded.homePath;
      }).pipe(Effect.orElseSucceed(() => ""));
      // `resolveClaudeConfigDirPath` yields its own `Path.Path` requirement;
      // satisfy it from the already-resolved `path` in scope so this stays
      // free of a `Path.Path` requirement of its own (see the `list`/`make`
      // split above — required for `Layer.provideMerge` to fully resolve it).
      return yield* resolveClaudeConfigDirPath({ homePath }, process.env).pipe(
        Effect.provideService(Path.Path, path),
      );
    },
  );

  const list: ClaudeSessionHistory["Service"]["list"] = Effect.fn("ClaudeSessionHistory.list")(
    function* (input) {
      const configDirPath = yield* resolveConfigDirPathForInstance(input.providerInstanceId);
      const projectDirPath = path.join(
        configDirPath,
        "projects",
        encodeCwdForClaudeProjectDir(input.workspaceRoot),
      );

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

  const bindResumeSession: ClaudeSessionHistory["Service"]["bindResumeSession"] = Effect.fn(
    "ClaudeSessionHistory.bindResumeSession",
  )(function* (input) {
    const instance = yield* providerInstanceRegistry.getInstance(input.providerInstanceId);
    if (!instance) {
      return yield* new ProviderValidationError({
        operation: "ClaudeSessionHistory.bindResumeSession",
        issue: `Provider instance '${input.providerInstanceId}' is not configured.`,
      });
    }
    if (instance.driverKind !== CLAUDE_PROVIDER) {
      return yield* new ProviderValidationError({
        operation: "ClaudeSessionHistory.bindResumeSession",
        issue: `resumeExternalSessionId is only supported for Claude Code provider instances; '${input.providerInstanceId}' is a '${instance.driverKind}' instance.`,
      });
    }
    yield* providerSessionDirectory.upsert({
      threadId: input.threadId,
      provider: instance.driverKind,
      providerInstanceId: input.providerInstanceId,
      resumeCursor: { resume: input.resumeExternalSessionId },
    });
  });

  return ClaudeSessionHistory.of({ list, bindResumeSession });
});

export const layer = Layer.effect(ClaudeSessionHistory, make);
