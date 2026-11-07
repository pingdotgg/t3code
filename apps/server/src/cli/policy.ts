import * as Console from "effect/Console";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { macosProfile, windowsAdml, windowsAdmx } from "../policy/policyTemplates.ts";
import { isProcessAlive, readServerRuntimeStateFile } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

type InstalledPolicy = Effect.Success<ReturnType<typeof ManagedPolicy.loadedPolicy>>;

const encodeReport = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toEncoded(Schema.Unknown), { space: 2 }),
);

const describePolicy = (
  policy: ManagedPolicy.ManagedPolicy["Service"],
  loaded: InstalledPolicy,
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
export const readRunningServer = Effect.fn("cli.policy.readRunningServer")(function* (
  statePath: string,
  installed: InstalledPolicy,
) {
  const state = yield* readServerRuntimeStateFile(statePath).pipe(
    Effect.catchTags({
      ServerRuntimeStateError: (error) =>
        Effect.logWarning(error.message).pipe(Effect.as("unreadable" as const)),
    }),
  );
  // A live server keeps running after its state file goes bad, so this says nothing either way.
  if (state === "unreadable") return { status: "unknown" } as const;
  if (Option.isNone(state) || !isProcessAlive(state.value.pid)) {
    return { status: "not-running" } as const;
  }
  const { pid, startedAt, managedPolicy: loaded } = state.value;
  if (loaded === undefined) return { status: "unknown", pid, startedAt } as const;
  const current = (loaded?.fingerprint ?? null) === (installed?.fingerprint ?? null);
  return { status: current ? "current" : "restart-required", pid, startedAt, loaded } as const;
});

export const describeRunningServer = (
  server: Effect.Success<ReturnType<typeof readRunningServer>>,
) => {
  if (server.status === "not-running") {
    return "No T3 Code server is running from this T3 home. The installed policy applies when one starts.";
  }
  if (!("pid" in server)) {
    return "Could not read this T3 home's server state, so a running server may not have this policy.";
  }
  const running = `The running server (pid ${server.pid}, started ${server.startedAt})`;
  if (server.status === "unknown") {
    return `${running} does not report which policy it loaded. Restart it to apply the installed policy.`;
  }
  const { loaded } = server;
  if (server.status === "current") {
    return loaded === null
      ? `${running} runs without a policy, as installed.`
      : `${running} loaded this policy.`;
  }
  const what =
    loaded === null
      ? "no policy"
      : `${loaded.organization}'s policy from ${loaded.source} (fingerprint ${loaded.fingerprint})`;
  return `${running} loaded ${what}. Restart T3 Code to apply the installed policy.`;
};

const showCommand = Command.make("show", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of human-readable output."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Show the policy installed on this machine, and whether the running server loaded it.",
  ),
  Command.withHandler(
    Effect.fn("cli.policy.show")(
      function* (flags) {
        // The command prints the policy itself; the server's startup log line would repeat it.
        const policy = yield* ManagedPolicy.ManagedPolicy.pipe(
          Effect.provide(
            ManagedPolicy.layer.pipe(
              Layer.provide(
                Layer.succeed(References.MinimumLogLevel, flags.json ? "Error" : "Warn"),
              ),
            ),
          ),
        );
        const installed = yield* ManagedPolicy.loadedPolicy(policy);
        const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
        const server = yield* readRunningServer(config.serverRuntimeStatePath, installed);
        if (flags.json) {
          const document = policy.document ?? null;
          yield* Console.log(yield* encodeReport({ installed, document, server }));
          return;
        }
        yield* Console.log(describePolicy(policy, installed));
        yield* Console.log(describeRunningServer(server));
      },
      // Logs go to stdout, where a script reads the JSON.
      (effect, flags) =>
        flags.json
          ? effect.pipe(Effect.provideService(References.MinimumLogLevel, "Error"))
          : effect,
    ),
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

const SAMPLE_POLICY: ManagedPolicyDocument = {
  schemaVersion: 1,
  organization: "Example Corp",
  limits: { maxRuntimeMode: "auto-accept-edits", clients: ["desktop"], telemetry: false },
};

const templatesCommand = Command.make("templates", {
  directory: Argument.String("directory").pipe(
    Argument.withDescription("Directory to write the templates to."),
  ),
  policy: Flag.String("policy").pipe(
    Flag.withDescription("Policy file to put in the macOS profile. Default: a small sample."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Write the Windows Group Policy template and a macOS configuration profile.",
  ),
  Command.withHandler(
    Effect.fn("cli.policy.templates")(function* ({ directory, policy }) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let document = SAMPLE_POLICY;
      if (Option.isSome(policy)) {
        if (!(yield* fs.exists(policy.value))) {
          return yield* new CliError.UserError({
            cause: policy.value,
            userMessage: `No policy file at ${policy.value}.`,
          });
        }
        const loaded = (yield* ManagedPolicy.load(policy.value)).document;
        if (loaded !== undefined) document = loaded;
      }
      const random = yield* SecureRandom.SecureRandom;
      const profile = macosProfile(document, {
        profile: yield* random.uuidV4().pipe(Effect.orDie),
        payload: yield* random.uuidV4().pipe(Effect.orDie),
      });
      if (profile._tag === "Invalid") {
        return yield* new CliError.UserError({ cause: document, userMessage: profile.reason });
      }
      const files = [
        [path.join(directory, "windows", "t3code.admx"), windowsAdmx()],
        [path.join(directory, "windows", "en-US", "t3code.adml"), windowsAdml()],
        [path.join(directory, "macos", "t3code.mobileconfig"), profile.profile],
      ] as const;
      for (const [file, contents] of files) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, contents);
        yield* Console.log(file);
      }
    }),
  ),
);

export const policyCommand = Command.make("policy").pipe(
  Command.withDescription("Inspect the administrator's managed policy."),
  Command.withSubcommands([showCommand, checkCommand, templatesCommand]),
);
