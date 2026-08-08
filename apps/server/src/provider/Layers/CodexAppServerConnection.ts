import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { expandHomePath } from "../../pathExpansion.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";

const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;

export interface CodexAppServerConnectionOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly appServerArgs?: ReadonlyArray<string>;
  readonly launchArgs?: string;
}

export interface CodexThreadListClient {
  readonly request: (
    method: "thread/list",
    payload: CodexRpc.ClientRequestParamsByMethod["thread/list"],
  ) => Effect.Effect<
    CodexRpc.ClientRequestResponsesByMethod["thread/list"],
    CodexErrors.CodexAppServerError
  >;
}

/**
 * Spawn and connect to a Codex app-server process in the caller's scope.
 * Session runtimes and one-shot discovery calls share this path so CODEX_HOME,
 * environment handling, process termination, and protocol setup cannot drift.
 */
export const makeCodexAppServerConnection = Effect.fn("makeCodexAppServerConnection")(function* (
  options: CodexAppServerConnectionOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
  const environment = {
    ...options.environment,
    ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
  };
  const extendEnv = options.environment === undefined;
  const spawnCommand = yield* resolveSpawnCommand(
    options.binaryPath,
    codexSessionAppServerArgs(options.appServerArgs, options.launchArgs),
    { env: environment, extendEnv },
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        env: environment,
        extendEnv,
        forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${options.binaryPath} app-server`,
            cause,
          }),
      ),
    );

  const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
    Layer.build,
    Effect.provideService(Scope.Scope, scope),
  );
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  return { child, client } as const;
});

const THREAD_LIST_PAGE_SIZE = 100;

/** Fetch every page from Codex's persisted thread catalog, newest first. */
export const listAllCodexThreads = Effect.fn("listAllCodexThreads")(function* (
  client: CodexThreadListClient,
) {
  const threads: EffectCodexSchema.V2ThreadListResponse["data"][number][] = [];
  const threadIds = new Set<string>();
  const requestedCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    if (cursor !== undefined) {
      if (requestedCursors.has(cursor)) {
        yield* Effect.logWarning("Codex thread/list returned a repeated pagination cursor", {
          cursor,
        });
        break;
      }
      requestedCursors.add(cursor);
    }

    const page = yield* client.request("thread/list", {
      archived: false,
      limit: THREAD_LIST_PAGE_SIZE,
      sortKey: "updated_at",
      sortDirection: "desc",
      useStateDbOnly: false,
      ...(cursor !== undefined ? { cursor } : {}),
    });

    for (const thread of page.data) {
      if (threadIds.has(thread.id)) continue;
      threadIds.add(thread.id);
      threads.push(thread);
    }

    const nextCursor = page.nextCursor ?? undefined;
    if (nextCursor === undefined) break;
    cursor = nextCursor;
  }

  return threads;
});
