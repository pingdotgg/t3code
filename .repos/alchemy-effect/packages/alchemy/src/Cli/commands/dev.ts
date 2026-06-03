import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import { SPAWNER_URL_ENV_KEY } from "../../Local/RpcProviderProxy.ts";
import * as RpcSpawner from "../../Local/RpcSpawner.ts";
import { envFile, force, profile, script, stage } from "./_shared.ts";
import { ExecStackOptions } from "./deploy.ts";

export const devCommand = Command.make(
  "dev",
  {
    force,
    main: script,
    envFile,
    stage,
    profile,
  },
  Effect.fn(
    function* (args) {
      const options = yield* Schema.encodeEffect(ExecStackOptions)({
        ...args,
        yes: true,
        dev: true,
      });
      const spawner = yield* RpcSpawner.RpcSpawner;
      // We no longer force Bun in development because this prevents us from testing in Node.
      const command =
        typeof globalThis.Bun !== "undefined"
          ? [
              "bun",
              "run",
              ...process.execArgv,
              "--watch",
              "--no-clear-screen",
              fileURLToPath(import.meta.resolve("alchemy/bin/exec.ts")),
            ]
          : [
              "node",
              ...process.execArgv,
              ...(isTransformTypesSupported()
                ? [
                    "--experimental-transform-types",
                    "--no-warnings=ExperimentalWarning",
                  ]
                : []),
              "--watch",
              "--watch-preserve-output",
              fileURLToPath(import.meta.resolve("alchemy/bin/exec.js")),
            ];
      const child = yield* ChildProcess.make(command[0], command.slice(1), {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ALCHEMY_EXEC_OPTIONS: JSON.stringify(options),
          [SPAWNER_URL_ENV_KEY]: spawner.url,
        },
        extendEnv: true,
        detached: false,
      });
      yield* child.exitCode;
    },
    (effect, args) =>
      Effect.provide(
        RpcSpawner.layerServer({
          profile: args.profile,
          envFile: Option.getOrUndefined(args.envFile),
        }),
      )(effect),
  ),
);

const isTransformTypesSupported = (
  version = process.versions.node,
): boolean => {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 7) || (major >= 23 && major < 26);
};
