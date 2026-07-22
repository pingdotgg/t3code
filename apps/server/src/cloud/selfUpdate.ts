// @effect-diagnostics nodeBuiltinImport:off
// node:child_process directly: the restart spawns must be detached
// fire-and-forget children that outlive this process, while Effect's
// ChildProcessSpawner ties every child to a scope that kills it.
import {
  ServerSelfUpdateError,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateResult,
  type ServerSelfUpdateMethod,
} from "@t3tools/contracts";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { BOOT_SERVICE_UNIT_FILE, quoteSystemdValue, renderBootServiceUnit } from "./bootService.ts";
import { ensurePinnedRuntimeInstalled } from "./pinnedRuntime.ts";

/**
 * Lets a connected client replace this server with another published `t3`
 * version over RPC — the only update path that works when the user is not at
 * the machine (phone against a home server, relay-managed box). The target
 * version is npm-installed into the pinned runtime and verified before
 * anything restarts, so a failed install leaves the running server untouched.
 */

const PREFLIGHT_TIMEOUT = Duration.seconds(30);
/** Grace between acknowledging the RPC and killing the process, so the
    response (and its relay hop) flushes before the socket drops. */
const RESTART_DELAY = Duration.seconds(2);

/** Exact npm versions only — never dist-tags — so the acknowledgement names
    the version that was actually installed. Also keeps the value safe to
    pass to npm and embed in filesystem paths. */
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ServerSelfUpdateHost {
  readonly execPath: string;
  readonly cliEntryPath: string;
  /** Original CLI arguments after the entry path, replayed on respawn. */
  readonly cliArgs: ReadonlyArray<string>;
  /** Fire-and-forget spawn that survives this process exiting. */
  readonly spawnDetached: (command: string, args: ReadonlyArray<string>) => void;
  readonly exitProcess: () => void;
}

function normalizeEntryPath(entryPath: string): string {
  return entryPath.replaceAll("\\", "/");
}

/**
 * Only a published npm artifact can be swapped for another version: dev
 * checkouts (apps/server/dist) and the desktop app's bundled backend have no
 * npm identity, and the desktop manages its own updates.
 */
export function isPublishedCliEntry(entryPath: string): boolean {
  return normalizeEntryPath(entryPath).includes("/node_modules/t3/dist/");
}

/**
 * How this process can be restarted into another version, or null when it
 * cannot. "boot-service" — this is the systemd-supervised process from
 * bootService.ts: rewrite the unit and let systemd swap it. "respawn" — a
 * foreground POSIX process running a published artifact: replace it with a
 * detached child. Windows foreground runs are unsupported for now (no
 * equivalent of the detach-and-exec handoff below).
 */
export const resolveServerSelfUpdateMethod: Effect.Effect<
  ServerSelfUpdateMethod | null,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const hostArguments = yield* HostProcessArguments;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entryPath = hostArguments[1] ?? "";
  if (entryPath === "") {
    return null;
  }

  const homeDir = env.HOME ?? "";
  if (platform === "linux" && homeDir !== "") {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", BOOT_SERVICE_UNIT_FILE);
    const unitReferencesEntry = yield* fs.readFileString(unitPath).pipe(
      Effect.map((unit) => unit.includes(quoteSystemdValue(entryPath))),
      Effect.orElseSucceed(() => false),
    );
    // INVOCATION_ID is set by systemd for the processes it spawns; requiring
    // it distinguishes the unit's own process (restarting the unit replaces
    // us) from a manual foreground run of the same pinned artifact (it would
    // not).
    if (unitReferencesEntry && (env.INVOCATION_ID ?? "") !== "") {
      return "boot-service";
    }
  }

  if ((platform === "linux" || platform === "darwin") && isPublishedCliEntry(entryPath)) {
    return "respawn";
  }

  return null;
}).pipe(Effect.withSpan("cloud.server_self_update.resolve_method"));

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

export const make = Effect.fn("cloud.server_self_update.make")(function* (options?: {
  readonly host?: Partial<ServerSelfUpdateHost>;
}) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const env = yield* HostProcessEnvironment;
  const hostExecPath = yield* HostProcessExecutablePath;
  const hostArguments = yield* HostProcessArguments;
  const method = yield* resolveServerSelfUpdateMethod;

  const host: ServerSelfUpdateHost = {
    execPath: options?.host?.execPath ?? hostExecPath,
    cliEntryPath: options?.host?.cliEntryPath ?? hostArguments[1] ?? "",
    cliArgs: options?.host?.cliArgs ?? hostArguments.slice(2),
    spawnDetached:
      options?.host?.spawnDetached ??
      ((command, args) => {
        NodeChildProcess.spawn(command, [...args], { detached: true, stdio: "ignore" }).unref();
      }),
    exitProcess: options?.host?.exitProcess ?? (() => process.exit(0)),
  };

  const inFlight = yield* Ref.make(false);

  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  /** Deferred so the RPC acknowledgement flushes before the process dies.
      Detached from the request scope: the triggering connection is exactly
      what the restart tears down. */
  const scheduleRestart = (restart: Effect.Effect<void>) =>
    Effect.sleep(RESTART_DELAY).pipe(
      Effect.andThen(restart),
      Effect.forkDetach({ startImmediately: true }),
    );

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (input) {
    if (method === null) {
      return yield* failWith(
        "This server cannot update itself; relaunch it manually with the new version.",
      );
    }
    const activeMethod = method;
    const targetVersion = input.targetVersion.trim();
    if (!EXACT_VERSION_PATTERN.test(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
    }

    const alreadyRunning = yield* Ref.getAndSet(inFlight, true);
    if (alreadyRunning) {
      return yield* failWith("A server update is already in progress.");
    }

    return yield* Effect.gen(function* () {
      const runtimePaths = yield* ensurePinnedRuntimeInstalled({
        baseDir: serverConfig.baseDir,
        version: targetVersion,
        fs,
        path,
        runner,
      }).pipe(Effect.mapError((error) => failWith(error.message, error)));

      // A broken artifact (failed native build, incompatible node) must be
      // caught while the current server is still alive to report it.
      const preflight = yield* runner
        .run({
          command: host.execPath,
          args: [runtimePaths.entryPath, "--version"],
          timeout: PREFLIGHT_TIMEOUT,
        })
        .pipe(
          Effect.mapError((cause) =>
            failWith(`Could not verify the installed t3@${targetVersion}.`, cause),
          ),
        );
      if (preflight.code !== 0) {
        return yield* failWith(
          `The installed t3@${targetVersion} failed its version check (exit code ${String(preflight.code)}).`,
        );
      }

      if (activeMethod === "boot-service") {
        const homeDir = env.HOME ?? "";
        const unitPath = path.join(homeDir, ".config", "systemd", "user", BOOT_SERVICE_UNIT_FILE);
        // Same shape bootService.install writes, so the next `t3 connect`
        // still recognizes the unit as current.
        const unit = renderBootServiceUnit({
          nodePath: host.execPath,
          t3EntryPath: runtimePaths.entryPath,
          baseDir: serverConfig.baseDir,
          logPath: path.join(serverConfig.logsDir, "boot-service.log"),
          unitPath,
        });
        yield* fs
          .writeFileString(unitPath, unit)
          .pipe(Effect.mapError((cause) => failWith("Could not update the systemd unit.", cause)));
        const reload = yield* runner
          .run({ command: "systemctl", args: ["--user", "daemon-reload"] })
          .pipe(Effect.mapError((cause) => failWith("Could not reload systemd units.", cause)));
        if (reload.code !== 0) {
          return yield* failWith(
            `Reloading systemd units failed (exit code ${String(reload.code)}).`,
          );
        }
        yield* Effect.logInfo("Server self-update installed; restarting boot service.", {
          targetVersion,
        });
        // systemd stops this process and starts the rewritten unit.
        yield* scheduleRestart(
          Effect.sync(() =>
            host.spawnDetached("systemctl", ["--user", "restart", BOOT_SERVICE_UNIT_FILE]),
          ),
        );
      } else {
        yield* Effect.logInfo("Server self-update installed; respawning.", { targetVersion });
        // The shim sleeps so this process has released its listeners before
        // the replacement binds them, then execs the new version with the
        // original CLI arguments.
        yield* scheduleRestart(
          Effect.sync(() => {
            host.spawnDetached("/bin/sh", [
              "-c",
              'sleep 1; exec "$@"',
              "t3-self-update",
              host.execPath,
              runtimePaths.entryPath,
              ...host.cliArgs,
            ]);
            host.exitProcess();
          }),
        );
      }

      return { targetVersion, method: activeMethod };
    }).pipe(Effect.ensuring(Ref.set(inFlight, false)));
  });

  return ServerSelfUpdate.of({ update });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
