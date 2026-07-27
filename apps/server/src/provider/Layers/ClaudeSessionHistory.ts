/**
 * ClaudeSessionHistory — reads Claude Code's on-disk session transcripts to
 * list resumable sessions for a given workspace root, powering the
 * `server.listClaudeResumableSessions` RPC (the "resume a previous Claude
 * Code session" picker). Claude-only: no other provider's on-disk transcript
 * format is understood here.
 *
 * Claude Code stores one directory per working directory under
 * `<config dir>/projects/`, named by replacing every non-alphanumeric
 * character in the absolute cwd with `-` (so `/Users/m/Documents/t3` becomes
 * `-Users-m-Documents-t3`). Each session is a `<sessionId>.jsonl` file inside
 * that directory — a stream of JSON records (`user`/`assistant` messages plus
 * assorted metadata lines) that Claude Code itself replays for `--resume`.
 *
 * @module provider/Layers/ClaudeSessionHistory
 */
import type {
  ServerClaudeResumableSession,
  ServerListClaudeResumableSessionsInput,
  ServerListClaudeResumableSessionsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveClaudeConfigDirPath } from "../Drivers/ClaudeSkills.ts";

const JSONL_EXTENSION = ".jsonl";
const MAX_LABEL_LENGTH = 80;

function encodeCwdForClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function truncateLabel(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_LABEL_LENGTH
    ? `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : trimmed;
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

export class ClaudeSessionHistory extends Context.Service<
  ClaudeSessionHistory,
  {
    readonly list: (
      input: ServerListClaudeResumableSessionsInput,
    ) => Effect.Effect<ServerListClaudeResumableSessionsResult>;
  }
>()("t3/provider/Layers/ClaudeSessionHistory") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Resolved once per server process: `CLAUDE_CONFIG_DIR` isn't expected to
  // change over the server's lifetime, and resolving it here (rather than
  // per-call) keeps `list`'s effect free of a `Path.Path` requirement.
  const configDirPath = yield* resolveClaudeConfigDirPath({ homePath: "" }, process.env);

  const list: ClaudeSessionHistory["Service"]["list"] = Effect.fn(
    "ClaudeSessionHistory.list",
  )(function* (input) {
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
            lastActiveAt: new Date(lastActiveAtMs).toISOString(),
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
  });

  return ClaudeSessionHistory.of({ list });
});

export const layer = Layer.effect(ClaudeSessionHistory, make);
