import { fileURLToPath } from "node:url";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { resolveStackEntrypoint } from "../../Alchemist/Entrypoint.ts";
import * as Contributions from "../../Contributions.ts";
import { SPAWNER_URL_ENV_KEY } from "../../Local/RpcProviderProxy.ts";
import * as RpcSpawner from "../../Local/RpcSpawner.ts";
import { LOG_FD_ENV, parseRecord, replayRecord } from "../../Util/LogRecord.ts";
import { nodeLoaderArgs } from "../../Util/Node.ts";
import { timedShutdownStep } from "../../Util/Shutdown.ts";
import { traceParentEnv } from "../../Util/TraceParent.ts";
import { DEV_RELOAD_EXIT_CODE, DevOptions } from "../DevOptions.ts";
import { consoleSettingsEnv, currentConsoleSettings, RunLog } from "../GlobalLog.ts";
import { suppressInterruptMessages } from "./errors.ts";
import {
  configPath,
  envFile,
  force,
  include,
  exclude,
  devStage,
  optionalConfig,
  profile,
  resolveStackArgs,
} from "./flags.ts";
import { logCommandFailure, VersionCheck } from "./instrument.ts";

/**
 * Trust the Floci emulator CA in `alchemy dev` so cross-cloud data planes
 * terminated by the emulator's self-signed cert (e.g. an AWS Lambda MicroVM
 * bound to a local Cloudflare Worker) are reachable from local workerd. workerd
 * reads its trusted certificates from `NODE_EXTRA_CA_CERTS` at runtime init, so
 * this must be present in the env of every spawned child (the exec worker, the
 * RPC sidecar, and the workerd instances they start). `ensureFloci` refreshes
 * the bundle at this stable path (and sets the variable itself once written);
 * never clobber a value the caller set, and don't point at a missing file —
 * Node/Bun warn about it on every startup.
 */

export const devCommand = Command.make(
  "dev",
  {
    force,
    include,
    exclude,
    config: optionalConfig,
    configPath,
    envFile,
    stage: devStage,
    profile,
  },
  Effect.fn(
    function* (rawArgs) {
      const args = yield* resolveStackArgs("dev")(rawArgs);
      // This process is only the exec child's supervisor; the child owns the
      // terminal and announces the Ctrl+C shutdown. Without this, a SIGINT
      // hits both processes and the interrupt message prints twice.
      yield* suppressInterruptMessages;
      const options = yield* Schema.encodeEffect(DevOptions)(args);
      // A missing entry is this process's error to report, not a stack
      // trace out of the exec child.
      yield* resolveStackEntrypoint(options.main);
      // Providers' dev environment (e.g. a local emulator's CA bundle). Set on
      // THIS process, so the RPC spawner's sidecars (and the workerd they
      // launch) inherit it — they are forked from here, not from the exec
      // child below.
      const env = yield* Contributions.devEnv().pipe(
        Effect.catchTag("ContributionError", (error) =>
          Effect.logWarning(error.message).pipe(Effect.as({})),
        ),
      );
      for (const [key, value] of Object.entries(env)) {
        process.env[key] ??= value;
      }
      const spawner = yield* RpcSpawner.RpcSpawner;
      // Neither runtime uses its native `--watch`: those hard-restart the exec
      // child with no teardown, leaving the previous generation's widget in
      // scrollback and never saying what changed. exec.ts watches the user's
      // stack graph itself. Under Node it reloads the graph in-process; under
      // Bun (which cannot evict evaluated modules) it tears down and exits
      // with DEV_RELOAD_EXIT_CODE, and this supervisor starts a fresh child.
      let command: [string, ...string[]];
      const entry = fileURLToPath(import.meta.resolve("alchemy/bin/exec.js"));
      if (typeof globalThis.Bun !== "undefined") {
        command = ["bun", "run", ...process.execArgv, entry];
      } else {
        // Node: the exec entry runs with alchemy's Oxc loader hooks,
        // exactly as bin/cli.js started this process. Select the loader from
        // this module's source or compiled location; the entry is always JS.
        // Node's own TypeScript support is never relied on. `process.execPath`,
        // not "node": the hooks are gated on THIS node's version. A
        // duplicate --import inherited via execArgv is harmless — the
        // second import of the same URL hits the module cache.
        command = [
          process.execPath,
          ...process.execArgv,
          ...nodeLoaderArgs(import.meta.url),
          entry,
        ];
      }
      const runLog = yield* RunLog;
      const consoleSettings = yield* currentConsoleSettings;
      // The child's records and spans join this command's trace.
      const traceEnv = yield* traceParentEnv;
      const runChild = ChildProcess.make(command[0], command.slice(1), {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ALCHEMY_EXEC_OPTIONS: JSON.stringify(options),
          ALCHEMY_DEV: "true",
          [LOG_FD_ENV]: "3",
          // The exec child renders the run's logs but never sees this argv.
          ...consoleSettingsEnv(consoleSettings),
          ...(process.env.NODE_EXTRA_CA_CERTS
            ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
            : {}),
          [SPAWNER_URL_ENV_KEY]: spawner.url,
          ...traceEnv,
        },
        extendEnv: true,
        // Same process group as this supervisor: the exec child owns the
        // terminal (TUI stdin), so the tty's Ctrl+C must reach it directly.
        detached: false,
        // The child's log records, for the run log this process writes.
        additionalFds: { fd3: { type: "output" } },
      }).pipe(
        Effect.flatMap((child) =>
          Effect.gen(function* () {
            const records = yield* child.getOutputFd(3).pipe(
              Stream.decodeText(),
              Stream.splitLines,
              // Already rendered by the child: into the run log only. A line
              // that doesn't decode is skipped, never ends the reader.
              Stream.runForEach((line) => {
                const record = parseRecord(line);
                return record === undefined
                  ? Effect.void
                  : replayRecord(record).pipe(
                      Effect.provideService(Logger.CurrentLoggers, new Set([runLog])),
                    );
              }),
              Effect.ignore,
              Effect.forkScoped,
            );
            // The pipe closes with the child: take its last records before
            // this scope (and the reader with it) closes.
            const drain = Fiber.join(records).pipe(Effect.timeout("2 seconds"), Effect.ignore);
            const code = yield* child.exitCode.pipe(
              // Ctrl+C reaches the child too (same process group): let it
              // finish its own shutdown and report it before this scope
              // kills whatever is left.
              Effect.onInterrupt(() =>
                child.exitCode.pipe(
                  Effect.timeout("5 seconds"),
                  Effect.ignore,
                  Effect.andThen(drain),
                  timedShutdownStep("stopped exec child"),
                ),
              ),
            );
            yield* drain;
            return code;
          }),
        ),
        Effect.scoped,
      );
      // Each child gets its own scope so a reload exit releases the old
      // handle before the replacement starts; the sidecar spawner lives in
      // the command scope and survives every restart.
      yield* Effect.repeat(runChild, {
        until: (code) => code !== DEV_RELOAD_EXIT_CODE,
      });
    },
    (effect, args) =>
      Effect.andThen(
        Effect.flatten(VersionCheck),
        Effect.provide(
          RpcSpawner.layerServer({
            profile: args.profile,
            envFile: Option.getOrUndefined(args.envFile),
          }),
        )(effect),
      ).pipe(logCommandFailure),
  ),
).pipe(Command.withDescription("Develop a stack with live reload"));
