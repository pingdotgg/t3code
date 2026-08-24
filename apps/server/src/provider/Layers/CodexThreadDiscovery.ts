import { type CodexSettings, TurnId } from "@t3tools/contracts";
import type {
  ProviderPersistedThread,
  ProviderPersistedThreadDiscoveryInput,
} from "../Services/ProviderAdapter.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { expandHomePath } from "../../pathExpansion.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { codexSessionAppServerArgs, resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

const PAGE_SIZE = 100;
const THREAD_READ_CONCURRENCY = 4;
const FORCE_KILL_AFTER = "2 seconds" as const;

function diagnosticErrorType(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    return String(cause._tag);
  }
  return typeof cause;
}

function unixSecondsToIso(seconds: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(seconds * 1_000));
}

function discoveryCursorForThread(
  thread: EffectCodexSchema.V2ThreadListResponse["data"][number],
): string {
  return `${unixSecondsToIso(thread.updatedAt)}:${thread.status.type}`;
}

export function selectCodexThreadsForRead(
  threads: ReadonlyArray<EffectCodexSchema.V2ThreadListResponse["data"][number]>,
  discoveryInput?: ProviderPersistedThreadDiscoveryInput,
): ReadonlyArray<EffectCodexSchema.V2ThreadListResponse["data"][number]> {
  return threads.filter((thread) => {
    if (
      thread.ephemeral ||
      (typeof thread.source === "object" && "subAgent" in thread.source) ||
      thread.threadSource === "memory_consolidation" ||
      discoveryInput?.excludeProviderThreadIds.has(thread.id) === true
    ) {
      return false;
    }
    const knownCursor = discoveryInput?.cursorByProviderThreadId.get(thread.id);
    return knownCursor !== discoveryCursorForThread(thread);
  });
}

function titleForThread(thread: EffectCodexSchema.V2ThreadReadResponse["thread"]): string {
  const name = thread.name?.trim();
  if (name) return name;
  const preview = thread.preview.trim().split("\n", 1)[0]?.trim();
  return preview || "Imported Codex thread";
}

function messagesForThread(
  thread: EffectCodexSchema.V2ThreadReadResponse["thread"],
): ProviderPersistedThread["messages"] {
  const messages: Array<ProviderPersistedThread["messages"][number]> = [];
  for (const turn of thread.turns) {
    if (turn.status === "inProgress") continue;
    const startedAt = unixSecondsToIso(turn.startedAt ?? thread.createdAt);
    const completedAt = unixSecondsToIso(turn.completedAt ?? turn.startedAt ?? thread.updatedAt);
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = item.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n")
          .trim();
        if (text) {
          messages.push({
            id: item.id,
            sourceOrdinal: messages.length,
            role: "user",
            text,
            turnId: TurnId.make(turn.id),
            createdAt: startedAt,
          });
        }
      }
      if (item.type === "agentMessage" && item.text.length > 0) {
        messages.push({
          id: item.id,
          sourceOrdinal: messages.length,
          role: "assistant",
          text: item.text,
          turnId: TurnId.make(turn.id),
          createdAt: completedAt,
        });
      }
    }
  }
  return messages;
}

export function toPersistedThread(
  thread: EffectCodexSchema.V2ThreadReadResponse["thread"],
): ProviderPersistedThread {
  return {
    providerThreadId: thread.id,
    cwd: thread.cwd,
    title: titleForThread(thread),
    createdAt: unixSecondsToIso(thread.createdAt),
    updatedAt: unixSecondsToIso(thread.updatedAt),
    discoveryCursor: discoveryCursorForThread(thread),
    sourceMetadata: {
      source: thread.source,
      threadSource: thread.threadSource ?? null,
      status: thread.status,
      sessionId: thread.sessionId,
      forkedFromId: thread.forkedFromId ?? null,
      parentThreadId: thread.parentThreadId ?? null,
      cliVersion: thread.cliVersion,
      modelProvider: thread.modelProvider,
      gitInfo: thread.gitInfo ?? null,
    },
    messages: messagesForThread(thread),
  };
}

export function readCodexThreadSnapshots<E>(
  threads: ReadonlyArray<EffectCodexSchema.V2ThreadListResponse["data"][number]>,
  readThread: (threadId: string) => Effect.Effect<EffectCodexSchema.V2ThreadReadResponse, E>,
): Effect.Effect<ReadonlyArray<ProviderPersistedThread>> {
  return Effect.forEach(
    threads,
    (thread) =>
      readThread(thread.id).pipe(
        Effect.map((response) => Option.some(toPersistedThread(response.thread))),
        Effect.catch((cause) =>
          Effect.logWarning("skipped unreadable persisted Codex thread", {
            providerThreadId: thread.id,
            errorType: diagnosticErrorType(cause),
          }).pipe(Effect.as(Option.none<ProviderPersistedThread>())),
        ),
      ),
    { concurrency: THREAD_READ_CONCURRENCY },
  ).pipe(Effect.map((threads) => threads.filter(Option.isSome).map((thread) => thread.value)));
}

export const discoverCodexThreads = Effect.fn("discoverCodexThreads")(function* (
  config: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  discoveryInput?: ProviderPersistedThreadDiscoveryInput,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeScope = yield* Scope.Scope;
  const resolvedHomePath = config.homePath ? expandHomePath(config.homePath) : undefined;
  const env = {
    ...environment,
    ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
  };
  const extendEnv = environment === undefined;
  const launchArgs = resolveCodexLaunchArgs(config.launchArgs, environment);
  const appServerArgs = codexSessionAppServerArgs(undefined, launchArgs);
  const spawnCommand = yield* resolveSpawnCommand(config.binaryPath, appServerArgs, {
    env,
    extendEnv,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: process.cwd(),
        env,
        extendEnv,
        forceKillAfter: FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, runtimeScope),
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${config.binaryPath} app-server`,
            cause,
          }),
      ),
    );

  yield* child.stderr.pipe(Stream.decodeText(), Stream.runDrain, Effect.forkIn(runtimeScope));

  const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
    Layer.build,
    Effect.provideService(Scope.Scope, runtimeScope),
  );
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );
  yield* client.request("initialize", buildCodexInitializeParams());
  yield* client.notify("initialized", undefined);

  const listed: Array<EffectCodexSchema.V2ThreadListResponse["data"][number]> = [];
  let cursor: string | null | undefined;
  do {
    const page = yield* client.request("thread/list", {
      ...(cursor !== undefined ? { cursor } : {}),
      limit: PAGE_SIZE,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    listed.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);

  return yield* readCodexThreadSnapshots(
    selectCodexThreadsForRead(listed, discoveryInput),
    (threadId) => client.request("thread/read", { threadId, includeTurns: true }),
  );
});
