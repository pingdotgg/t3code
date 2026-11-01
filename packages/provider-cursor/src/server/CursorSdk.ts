// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- The guard runs in Node's unhandled-rejection callback, outside an Effect runtime. stderr must match Node's default unhandled-rejection print.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { Agent, createAgentPlatform, Cursor, SqliteLocalAgentStore } from "./sdk.ts";

// The SDK leaves a shell-error promise unhandled, which would exit the server.
const CURSOR_SHELL_SPAWN_MARKERS = [
  "dump_zsh_state",
  "dump_bash_state",
  "__CURSOR_SANDBOX_ENV_RESTORE",
] as const;

function isCursorShellSpawnFailure(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) {
    return false;
  }
  const syscall = Reflect.get(reason, "syscall");
  const code = Reflect.get(reason, "code");
  const spawnargs = Reflect.get(reason, "spawnargs");
  if (typeof syscall !== "string" || !syscall.startsWith("spawn") || typeof code !== "string") {
    return false;
  }
  if (!Array.isArray(spawnargs)) {
    return false;
  }
  return spawnargs.some(
    (arg) =>
      typeof arg === "string" && CURSOR_SHELL_SPAWN_MARKERS.some((marker) => arg.includes(marker)),
  );
}

/**
 * After a local exec fails, the SDK writes a final frame to the exec's stream from
 * a promise nothing awaits. If that stream has already closed, the write rejects.
 * The SDK's class is minified, so only its `name` identifies it.
 */
function isCursorClosedStreamWrite(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "WriteIterableClosedError";
}

function onUnhandledRejection(reason: unknown): void {
  if (isCursorShellSpawnFailure(reason)) {
    console.error("Cursor shell spawn failed. The server will keep running.", reason);
    return;
  }
  if (isCursorClosedStreamWrite(reason)) {
    console.error("Cursor SDK wrote to a closed exec stream. The server will keep running.");
    return;
  }
  if (process.listenerCount("unhandledRejection") > 1) {
    return;
  }
  console.error(reason);
  process.exit(1);
}

const decodeCursorCliConfig = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      network: Schema.optionalKey(
        Schema.Struct({ useHttp1ForAgent: Schema.optionalKey(Schema.Boolean) }),
      ),
    }),
  ),
);

// Proxies without HTTP/2 need this Cursor CLI setting, which the SDK never reads itself.
const readCursorCliUseHttp1ForAgent = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { CURSOR_CONFIG_DIR, XDG_CONFIG_HOME } = yield* HostProcess.Environment;
  const configDirectory = CURSOR_CONFIG_DIR?.trim()
    ? CURSOR_CONFIG_DIR
    : XDG_CONFIG_HOME?.trim()
      ? path.join(XDG_CONFIG_HOME, "cursor")
      : path.join(yield* HostProcess.HomeDirectory, ".cursor");
  const config = yield* fileSystem
    .readFileString(path.join(configDirectory, "cli-config.json"))
    .pipe(Effect.flatMap(decodeCursorCliConfig), Effect.option);
  return Option.isSome(config) && config.value.network?.useHttp1ForAgent === true;
});

/** Keeps the shell spawn guard armed while in-process agents run. */
export class CursorSdk extends Context.Service<
  CursorSdk,
  {
    readonly Agent: typeof Agent;
    readonly createAgentPlatform: typeof createAgentPlatform;
    readonly SqliteLocalAgentStore: typeof SqliteLocalAgentStore;
  }
>()("@t3tools/provider-cursor/server/CursorSdk") {}

/** Provide once per process: a second guard would defer to the first and swallow real rejections. */
export const layer = Layer.effect(
  CursorSdk,
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.on("unhandledRejection", onUnhandledRejection);
      }),
      () =>
        Effect.sync(() => {
          process.off("unhandledRejection", onUnhandledRejection);
        }),
    );
    // The SDK picks the agent transport per process, so no provider instance can own this.
    if (yield* readCursorCliUseHttp1ForAgent) {
      yield* Effect.acquireRelease(
        Effect.sync(() => Cursor.configure({ local: { useHttp1ForAgent: true } })),
        () => Effect.sync(() => Cursor.configure({ local: { useHttp1ForAgent: null } })),
      );
    }
    return CursorSdk.of({ Agent, createAgentPlatform, SqliteLocalAgentStore });
  }),
);
