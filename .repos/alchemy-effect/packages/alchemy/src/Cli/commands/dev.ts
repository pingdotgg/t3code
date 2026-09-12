import * as Floci from "@alchemy.run/floci";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import { SPAWNER_URL_ENV_KEY } from "../../Local/RpcProviderProxy.ts";
import * as RpcSpawner from "../../Local/RpcSpawner.ts";
import { nodeLoaderArgs } from "../../Util/Node.ts";
import { DEV_RELOAD_EXIT_CODE, DevOptions } from "../DevOptions.ts";
import {
  configPath,
  envFile,
  force,
  devStage,
  optionalConfig,
  profile,
  resolveStackArgs,
} from "./flags.ts";
import { suppressInterruptMessages } from "./errors.ts";

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
      const fs = yield* FileSystem.FileSystem;
      // Set on THIS process too, so the RPC spawner's sidecars (and the workerd
      // they launch) inherit it — they are forked from here, not from the exec
      // child below.
      if (yield* fs.exists(Floci.FLOCI_CA_PATH)) {
        process.env.NODE_EXTRA_CA_CERTS ??= Floci.FLOCI_CA_PATH;
      }
      const spawner = yield* RpcSpawner.RpcSpawner;
      // Neither runtime uses its native `--watch`: those hard-restart the exec
      // child with no teardown, leaving the previous generation's widget in
      // scrollback and never saying what changed. exec.ts watches the user's
      // stack graph itself. Under Node it reloads the graph in-process; under
      // Bun (which cannot evict evaluated modules) it tears down and exits
      // with DEV_RELOAD_EXIT_CODE, and this supervisor starts a fresh child.
      let command: [string, ...string[]];
      if (typeof globalThis.Bun !== "undefined") {
        command = [
          "bun",
          "run",
          ...process.execArgv,
          fileURLToPath(import.meta.resolve("alchemy/bin/exec.ts")),
        ];
      } else {
        // Node: the exec entry runs with alchemy's Oxc loader hooks,
        // exactly as bin/cli.js started this process (checkout: the
        // .ts entry plus src-condition resolution; published: the .js
        // bundle plus the loader for the user's stack). Node's own
        // TypeScript support is never relied on. `process.execPath`,
        // not "node": the hooks are gated on THIS node's version. A
        // duplicate --import inherited via execArgv is harmless — the
        // second import of the same URL hits the module cache.
        const entry = fileURLToPath(
          import.meta.resolve(
            import.meta.url.endsWith(".ts")
              ? "alchemy/bin/exec.ts"
              : "alchemy/bin/exec.js",
          ),
        );
        command = [
          process.execPath,
          ...process.execArgv,
          ...nodeLoaderArgs(entry),
          entry,
        ];
      }
      const runChild = ChildProcess.make(command[0], command.slice(1), {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ALCHEMY_EXEC_OPTIONS: JSON.stringify(options),
          ALCHEMY_DEV: "true",
          ...(process.env.NODE_EXTRA_CA_CERTS
            ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
            : {}),
          [SPAWNER_URL_ENV_KEY]: spawner.url,
        },
        extendEnv: true,
        // Same process group as this supervisor: the exec child owns the
        // terminal (TUI stdin), so the tty's Ctrl+C must reach it directly.
        detached: false,
      }).pipe(
        Effect.flatMap((child) => child.exitCode),
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
      Effect.provide(
        RpcSpawner.layerServer({
          profile: args.profile,
          envFile: Option.getOrUndefined(args.envFile),
        }),
      )(effect),
  ),
).pipe(Command.withDescription("Develop a stack with live reload"));
