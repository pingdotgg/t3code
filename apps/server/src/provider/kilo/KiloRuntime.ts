import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { signalProcessGroup } from "../../process/processGroup.ts";
import * as KiloSessionClient from "./KiloSessionClient.ts";
import * as ServerLedger from "../OpenCodeServerLedger.ts";

export class KiloRuntimeError extends Schema.TaggedError<KiloRuntimeError>()("KiloRuntimeError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

export interface KiloConnection {
  readonly client: Effect.Success<ReturnType<typeof KiloSessionClient.make>>;
  readonly stop: Effect.Effect<void>;
  readonly cleanup: Effect.Effect<void>;
  readonly exitCode: Effect.Effect<number>;
  readonly isRunning: Effect.Effect<boolean>;
}

export class KiloRuntime extends Context.Service<
  KiloRuntime,
  {
    readonly open: (
      directory: string,
    ) => Effect.Effect<KiloConnection, KiloRuntimeError, Scope.Scope>;
  }
>()("t3/provider/kilo/KiloRuntime") {}

const isRuntimeError = Schema.is(KiloRuntimeError);

const authSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeAuth = Schema.decodeUnknownEffect(authSchema);
const encodeAuth = Schema.encodeEffect(authSchema);

/** Freeze the selected credential source; never fall back after a read/parse failure. */
export const readAuth = Effect.fn("KiloRuntime.readAuth")(function* (
  profileDirectory: string,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.gen(function* () {
    const contents =
      environment.KILO_AUTH_CONTENT ??
      (yield* fs
        .readFileString(path.join(profileDirectory, "data", "kilo", "auth.json"))
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
          ),
        ));
    const auth = yield* decodeAuth(contents);
    // Stable key order keeps harmless formatting changes from retiring sessions.
    return yield* encodeAuth(
      Object.fromEntries(Object.entries(auth).toSorted(([a], [b]) => a.localeCompare(b))),
    );
  }).pipe(
    Effect.mapError(
      () =>
        new KiloRuntimeError({
          operation: "authentication",
          detail:
            "Could not read the selected Kilo credentials. Check the profile and reload the provider.",
        }),
    ),
  );
});

/** Every open owns a process. Registry replacement closes the old account's process scopes. */
export const make = Effect.fn("KiloRuntime.make")(function* (input: {
  readonly instanceId: string;
  readonly binaryPath: string;
  /** An XDG root for this account, not the Kilo data directory itself. */
  readonly profileDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly authContent?: string;
  /** Stable T3 state directory; process ownership must survive profile removal. */
  readonly processStateDirectory?: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
  const owner = yield* Effect.scope;
  const fail = (operation: string, detail: string) => (cause: unknown) =>
    new KiloRuntimeError({ operation, detail, cause });
  const profile = path.resolve(input.profileDirectory);
  const ledger = yield* ServerLedger.make({
    stateDir: input.processStateDirectory ?? path.join(profile, "t3-processes"),
  });
  if (input.processStateDirectory) {
    // The server-global ledger also reaps at startup, even when no Kilo profile
    // remains configured. Do not block model discovery on orphan shutdown.
    yield* ledger.reapOrphans.pipe(Effect.forkIn(owner));
    const legacy = yield* ServerLedger.make({ stateDir: path.join(profile, "t3-processes") });
    yield* legacy.reapOrphans.pipe(Effect.forkIn(owner));
  } else yield* ledger.reapOrphans;
  const authContent = input.authContent ?? (yield* readAuth(profile, input.environment));
  const environment: NodeJS.ProcessEnv = {
    ...input.environment,
    XDG_CONFIG_HOME: path.join(profile, "config"),
    XDG_DATA_HOME: path.join(profile, "data"),
    XDG_CACHE_HOME: path.join(profile, "cache"),
    XDG_STATE_HOME: path.join(profile, "state"),
    KILO_DISABLE_AUTOUPDATE: "1",
    // Native configuration is trusted, as with OpenCode. Tool approvals do not
    // sandbox plugins or MCP initialization, including legacy configuration.
    // Background children outlive root turns and need a separate T3 continuation contract.
    KILO_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false",
    KILO_SERVER_USERNAME: "kilo",
    // The CLI supports this immutable credential source. A login in the selected
    // profile cannot change credentials underneath an already running process.
    KILO_AUTH_CONTENT: authContent,
  };
  let closed = false;
  const checkAuth = Effect.gen(function* () {
    const current = yield* readAuth(profile, input.environment);
    if (closed || current !== authContent) {
      closed = true;
      return yield* new KiloRuntimeError({
        operation: "authentication",
        detail: "Kilo credentials changed. Reload the provider and start a new thread.",
      });
    }
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.tapError(() =>
      Effect.sync(() => {
        closed = true;
      }),
    ),
  );
  yield* Scope.addFinalizer(
    owner,
    Effect.sync(() => {
      closed = true;
    }),
  );
  // Readiness output can contain project/plugin diagnostics; never include it in client errors.
  return KiloRuntime.of({
    open: Effect.fn("KiloRuntime.open")(function* (directory) {
      if (closed)
        return yield* new KiloRuntimeError({
          operation: "open",
          detail: "Kilo account runtime has been retired.",
        });
      yield* checkAuth;
      const caller = yield* Effect.scope;
      const scope = yield* Scope.fork(owner);
      yield* Scope.addFinalizer(caller, Scope.close(scope, Exit.void));
      const start = Effect.gen(function* () {
        for (const name of ["config", "data", "cache", "state"]) {
          yield* fs
            .makeDirectory(path.join(profile, name), { recursive: true })
            .pipe(Effect.mapError(fail("profile", "Could not prepare the Kilo account profile.")));
        }
        const password = Encoding.encodeBase64Url(
          yield* crypto
            .randomBytes(32)
            .pipe(Effect.mapError(fail("password", "Could not secure the local Kilo server."))),
        );
        const command = yield* resolveSpawnCommand(
          input.binaryPath,
          ["serve", "--hostname=127.0.0.1", "--port=0"],
          { env: environment, extendEnv: false },
        );
        // Forget only after the owned group is stopped, including failed readiness.
        const ledgerScope = yield* Scope.fork(scope);
        const child = yield* spawner
          .spawn(
            ChildProcess.make(command.command, command.args, {
              cwd: directory,
              env: { ...environment, KILO_SERVER_PASSWORD: password },
              extendEnv: false,
              detached: platform !== "win32",
              shell: command.shell,
            }),
          )
          .pipe(Effect.mapError(fail("spawn", "Could not start Kilo. Check the binary path.")));
        // Only this captured process group is signalled. No process-name matching.
        const cleanup = yield* Effect.cached(
          Effect.uninterruptible(
            platform === "win32"
              ? child
                  .kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" })
                  .pipe(Effect.ignore)
              : Effect.sync(() => {
                  try {
                    signalProcessGroup(Number(child.pid), "SIGTERM");
                  } catch {
                    /* already exited */
                  }
                }).pipe(
                  Effect.andThen(
                    child.exitCode.pipe(Effect.timeoutOption("1 second"), Effect.ignore),
                  ),
                  Effect.andThen(
                    Effect.sync(() => {
                      try {
                        signalProcessGroup(Number(child.pid), "SIGKILL");
                      } catch {
                        /* already exited */
                      }
                    }),
                  ),
                ),
          ),
        );
        yield* Effect.addFinalizer(() => cleanup);
        const forget = yield* ledger.track({
          pid: Number(child.pid),
          port: 0,
          args: ["serve", "--hostname=127.0.0.1", "--port=0"],
        });
        yield* Scope.addFinalizer(ledgerScope, forget);
        const guard = checkAuth.pipe(Effect.onError(() => cleanup));
        // Observe idle or in-flight account replacement as well as request boundaries.
        // Never read credential files once per SSE event.
        yield* Effect.forever(Effect.sleep("250 millis").pipe(Effect.andThen(guard))).pipe(
          Effect.ignore,
          Effect.forkIn(scope),
        );
        const ready = yield* Deferred.make<string, KiloRuntimeError>();
        let output = "";
        yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => {
            output = (output + chunk).slice(-65536);
            const match = /kilo server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
            return match ? Deferred.succeed(ready, match[1]!).pipe(Effect.asVoid) : Effect.void;
          }),
          Effect.ignore,
          Effect.forkIn(scope),
        );
        yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
        const exitCode = child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => -1),
          // Native exit can leave configured MCP/plugin children in the group,
          // including when no T3 turn is active. The cached cleanup owns that group.
          Effect.tap(() => cleanup),
        );
        yield* exitCode.pipe(
          Effect.flatMap((code) =>
            Deferred.fail(
              ready,
              new KiloRuntimeError({
                operation: "startup",
                detail: `Kilo exited during startup (code ${code}).`,
              }),
            ),
          ),
          Effect.forkIn(scope),
        );
        const url = yield* Deferred.await(ready).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            isRuntimeError(cause)
              ? cause
              : fail(
                  "startup",
                  "Kilo did not become ready. Check its installation and configuration.",
                )(cause),
          ),
        );
        const client = yield* KiloSessionClient.make({
          instanceId: input.instanceId,
          directory,
          baseUrl: url,
          serverPassword: password,
          beforeRequest: guard.pipe(
            Effect.mapError(
              () =>
                new KiloSessionClient.KiloSessionError({
                  operation: "authentication",
                  reason: "wrong_owner",
                }),
            ),
          ),
        }).pipe(
          Effect.mapError(
            fail(
              "health",
              "Kilo's authenticated health check failed. This provider requires version 7.8.3.",
            ),
          ),
        );
        if (!(yield* child.isRunning.pipe(Effect.orElseSucceed(() => false)))) {
          return yield* new KiloRuntimeError({
            operation: "startup",
            detail: "Kilo exited before readiness completed.",
          });
        }
        return {
          stop: Scope.close(scope, Exit.void),
          cleanup,
          client,
          exitCode,
          isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
        } satisfies KiloConnection;
      });
      return yield* start.pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
    }),
  });
});
