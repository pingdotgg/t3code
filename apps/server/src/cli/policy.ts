import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const describePolicy = (
  policy: ManagedPolicy.ManagedPolicy["Service"],
  loaded: Effect.Success<ReturnType<typeof ManagedPolicy.loadedPolicy>>,
) => {
  const { document } = policy;
  if (document === undefined || loaded === null) {
    return "No managed policy on this machine. Every setting belongs to the user.\n";
  }
  const settings = Object.entries(document.settings ?? {});
  const lines = [
    `Managed by ${document.organization} (${policy.path}, fingerprint ${loaded.fingerprint}).`,
    ...(document.supportUrl === undefined ? [] : [`Support: ${document.supportUrl}`]),
    "",
    settings.length === 0 ? "No managed settings." : "Settings:",
    ...settings.map(
      ([path, setting]) =>
        `  ${path} = ${JSON.stringify(setting.value)} (${setting.locked ? "locked" : "default"})`,
    ),
  ];
  if (document.limits !== undefined) {
    lines.push("", "Limits:", JSON.stringify(document.limits, null, 2));
  }
  return `${lines.join("\n")}\n`;
};

/** Whether the server running from this T3 home loaded the installed policy, which waits for a restart. */
export const describeRunningServer = Effect.fn("cli.policy.describeRunningServer")(function* (
  statePath: string,
  installed: Effect.Success<ReturnType<typeof ManagedPolicy.loadedPolicy>>,
) {
  const state = yield* readPersistedServerRuntimeState(statePath);
  if (Option.isNone(state) || !isProcessAlive(state.value.pid)) {
    return "No T3 Code server is running from this T3 home. The installed policy applies when one starts.";
  }
  const { pid, startedAt, managedPolicy: loaded } = state.value;
  const server = `The running server (pid ${pid}, started ${startedAt})`;
  if (loaded === undefined) {
    return `${server} does not report which policy it loaded. Restart it to apply the installed policy.`;
  }
  if ((loaded?.fingerprint ?? null) === (installed?.fingerprint ?? null)) {
    return loaded === null
      ? `${server} runs without a policy, as installed.`
      : `${server} loaded this policy.`;
  }
  const what =
    loaded === null
      ? "no policy"
      : `${loaded.organization}'s policy from ${loaded.source} (fingerprint ${loaded.fingerprint})`;
  return `${server} loaded ${what}. Restart T3 Code to apply the installed policy.`;
});

const showCommand = Command.make("show", projectLocationFlags).pipe(
  Command.withDescription(
    "Show the policy installed on this machine, and whether the running server loaded it.",
  ),
  Command.withHandler(
    Effect.fn("cli.policy.show")(function* (flags) {
      // The command prints the policy itself; the server's startup log line would repeat it.
      const policy = yield* ManagedPolicy.ManagedPolicy.pipe(
        Effect.provide(
          ManagedPolicy.layer.pipe(
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
          ),
        ),
      );
      const installed = yield* ManagedPolicy.loadedPolicy(policy);
      yield* Console.log(describePolicy(policy, installed));
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      yield* Console.log(yield* describeRunningServer(config.serverRuntimeStatePath, installed));
    }),
  ),
);

const checkCommand = Command.make("check", {
  file: Argument.String("file").pipe(Argument.withDescription("Policy file to validate.")),
}).pipe(
  Command.withDescription("Validate a policy file before deploying it."),
  Command.withHandler(
    Effect.fn("cli.policy.check")(function* ({ file }) {
      // Startup treats a missing file as no policy; a draft that is not there checks nothing.
      if (!(yield* (yield* FileSystem.FileSystem).exists(file))) {
        return yield* new CliError.UserError({
          cause: file,
          userMessage: `No policy file at ${file}.`,
        });
      }
      const policy = yield* ManagedPolicy.load(file);
      yield* Console.log(describePolicy(policy, yield* ManagedPolicy.loadedPolicy(policy)));
    }),
  ),
);

export const policyCommand = Command.make("policy").pipe(
  Command.withDescription("Inspect the administrator's managed policy."),
  Command.withSubcommands([showCommand, checkCommand]),
);
