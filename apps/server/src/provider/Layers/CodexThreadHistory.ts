/**
 * CodexThreadHistory - read-only discovery of persisted Codex conversations.
 *
 * This deliberately talks to Codex through its app-server protocol instead of
 * reading JSONL rollout files directly. That keeps T3 compatible with Codex's
 * own storage changes and, importantly, never modifies a Codex conversation
 * file. Discovery may update Codex's own derived state database as part of
 * Codex's normal read path, which is why this bridge does not promise a
 * filesystem-level "zero write" guarantee.
 *
 * @module provider/Layers/CodexThreadHistory
 */
import type { CodexSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";

import { expandHomePath } from "../../pathExpansion.ts";
import type {
  ProviderThreadHistory,
  ProviderThreadHistoryCandidate,
  ProviderThreadHistorySource,
} from "../ProviderDriver.ts";
import { ProviderThreadHistoryError } from "../Errors.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

const CODEX_THREAD_DISCOVERY_PAGE_SIZE = 100;
const CODEX_THREAD_DISCOVERY_MAX_RESULTS = 500;
// Read one additional session so an exact 500-result list is not incorrectly
// labelled as truncated. Only the first 500 are returned to the client.
const CODEX_THREAD_DISCOVERY_SCAN_LIMIT = CODEX_THREAD_DISCOVERY_MAX_RESULTS + 1;
const CODEX_THREAD_HISTORY_MAX_MESSAGES = 2_000;
const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;

type CodexAppServerClient = CodexClient.CodexAppServerClient["Service"];
type CodexThreadListEntry = CodexSchema.V2ThreadListResponse["data"][number];
type CodexThreadReadEntry = CodexSchema.V2ThreadReadResponse["thread"];

function toIsoTimestamp(value: number): string {
  const timestamp = DateTime.make(Number.isFinite(value) ? value * 1_000 : 0);
  return DateTime.formatIso(Option.getOrElse(timestamp, () => DateTime.makeUnsafe(0)));
}

function trimToNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function titleFromThread(input: {
  readonly name?: string | null;
  readonly preview: string;
}): string {
  const title = trimToNonEmpty(input.name);
  if (title) return title.slice(0, 160);
  const preview = input.preview.trim().split(/\r?\n/, 1)[0]?.trim();
  return preview && preview.length > 0 ? preview.slice(0, 160) : "Untitled Codex session";
}

function toThreadHistoryError(operation: "list" | "read") {
  return (cause: CodexErrors.CodexAppServerError) =>
    new ProviderThreadHistoryError({
      provider: "codex",
      operation,
      detail: "Codex app-server could not read persisted thread history.",
      cause,
    });
}

function sourceLabel(source: CodexThreadListEntry["source"]): string {
  if (typeof source === "string") return source;
  if ("custom" in source) return trimToNonEmpty(source.custom) ?? "custom";
  return "sub-agent";
}

function toCandidate(
  thread: CodexThreadListEntry,
  archived: boolean,
): ProviderThreadHistoryCandidate | undefined {
  if (
    thread.ephemeral ||
    thread.parentThreadId ||
    thread.source === "exec" ||
    (typeof thread.source !== "string" && "subAgent" in thread.source)
  ) {
    return undefined;
  }
  return {
    externalThreadId: thread.id,
    title: titleFromThread(thread),
    preview: thread.preview,
    createdAt: toIsoTimestamp(thread.createdAt),
    updatedAt: toIsoTimestamp(thread.updatedAt),
    source: sourceLabel(thread.source),
    archived,
  };
}

function textFromUserMessage(
  content: ReadonlyArray<CodexSchema.V2ThreadReadResponse__UserInput>,
): string {
  const parts: string[] = [];
  for (const input of content) {
    switch (input.type) {
      case "text":
        if (input.text.trim().length > 0) parts.push(input.text);
        break;
      case "image":
      case "localImage":
        parts.push("[Image attachment]");
        break;
      case "audio":
      case "localAudio":
        parts.push("[Audio attachment]");
        break;
      case "skill":
        parts.push(`[Skill: ${input.name}]`);
        break;
      case "mention":
        parts.push(`@${input.name}`);
        break;
    }
  }
  return parts.join("\n").trim();
}

function toHistory(thread: CodexThreadReadEntry): ProviderThreadHistory {
  const messages: ProviderThreadHistory["messages"][number][] = [];
  for (const turn of thread.turns) {
    const createdAt = toIsoTimestamp(turn.startedAt ?? thread.createdAt);
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = textFromUserMessage(item.content);
        if (text.length > 0) {
          messages.push({
            externalMessageId: item.id,
            role: "user",
            text,
            createdAt,
          });
        }
        continue;
      }
      if (item.type === "agentMessage" && item.text.trim().length > 0) {
        messages.push({
          externalMessageId: item.id,
          role: "assistant",
          text: item.text,
          createdAt,
        });
      }
    }
  }
  return {
    externalThreadId: thread.id,
    title: titleFromThread(thread),
    createdAt: toIsoTimestamp(thread.createdAt),
    messages: messages.slice(-CODEX_THREAD_HISTORY_MAX_MESSAGES),
  };
}

function makeAppServerClientRunner(input: {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  return <A>(
    cwd: string,
    run: (client: CodexAppServerClient) => Effect.Effect<A, CodexErrors.CodexAppServerError>,
  ): Effect.Effect<A, CodexErrors.CodexAppServerError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const homePath = input.config.homePath ? expandHomePath(input.config.homePath) : undefined;
        const environment = {
          ...input.environment,
          ...(homePath ? { CODEX_HOME: homePath } : {}),
        };
        const spawnCommand = yield* resolveSpawnCommand(
          input.config.binaryPath,
          codexAppServerArgs(resolveCodexLaunchArgs(input.config.launchArgs, input.environment)),
          { env: environment, extendEnv: true },
        );
        const child = yield* input.spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd,
              env: environment,
              extendEnv: true,
              forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
              shell: spawnCommand.shell,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new CodexErrors.CodexAppServerSpawnError({
                  command: `${input.config.binaryPath} app-server`,
                  cause,
                }),
            ),
          );
        const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(clientContext),
        );
        yield* client.request("initialize", buildCodexInitializeParams());
        yield* client.notify("initialized", undefined);
        return yield* run(client);
      }),
    );
}

/**
 * Build a read-only session-history source for one configured Codex instance.
 * The driver captures its effective (including shadow-home) configuration, so
 * discovery always sees the exact same Codex home as normal T3 continuations.
 */
export function makeCodexThreadHistory(input: {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): ProviderThreadHistorySource {
  const withClient = makeAppServerClientRunner(input);

  const listThreads: ProviderThreadHistorySource["listThreads"] = ({ cwd }) =>
    withClient(cwd, (client) =>
      Effect.gen(function* () {
        const threads: ProviderThreadHistoryCandidate[] = [];
        let truncated = false;
        for (const archived of [false, true] as const) {
          let cursor: string | undefined;
          do {
            const remaining = CODEX_THREAD_DISCOVERY_SCAN_LIMIT - threads.length;
            if (remaining <= 0) {
              truncated = true;
              break;
            }
            const response = yield* client.request("thread/list", {
              archived,
              cwd,
              limit: Math.min(CODEX_THREAD_DISCOVERY_PAGE_SIZE, remaining),
              sortKey: "recency_at",
              sortDirection: "desc",
              sourceKinds: ["cli", "vscode", "appServer", "unknown"],
              ...(cursor ? { cursor } : {}),
            });
            for (const thread of response.data) {
              const candidate = toCandidate(thread, archived);
              if (candidate) threads.push(candidate);
            }
            if (threads.length > CODEX_THREAD_DISCOVERY_MAX_RESULTS) {
              truncated = true;
              break;
            }
            cursor = response.nextCursor ?? undefined;
          } while (cursor);
          if (truncated) break;
        }
        threads.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        return {
          threads: threads.slice(0, CODEX_THREAD_DISCOVERY_MAX_RESULTS),
          truncated,
        };
      }),
    ).pipe(Effect.mapError(toThreadHistoryError("list")));

  const readThreads: ProviderThreadHistorySource["readThreads"] = ({ cwd, externalThreadIds }) =>
    withClient(cwd, (client) =>
      Effect.forEach(
        externalThreadIds,
        (externalThreadId) =>
          client
            .request("thread/read", {
              threadId: externalThreadId,
              includeTurns: true,
            })
            .pipe(Effect.map((response) => toHistory(response.thread))),
        { concurrency: 1 },
      ),
    ).pipe(Effect.mapError(toThreadHistoryError("read")));

  return { listThreads, readThreads };
}

export const CodexThreadHistoryConstants = {
  discoveryMaxResults: CODEX_THREAD_DISCOVERY_MAX_RESULTS,
  historyMaxMessages: CODEX_THREAD_HISTORY_MAX_MESSAGES,
} as const;
