import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { macosProfile, windowsAdml, windowsAdmx } from "../policy/policyTemplates.ts";

const describePolicy = (policy: ManagedPolicy.ManagedPolicy["Service"]) => {
  const { document } = policy;
  if (document === undefined) {
    return "No managed policy on this machine. Every setting belongs to the user.\n";
  }
  const settings = Object.entries(document.settings ?? {});
  const lines = [
    `Managed by ${document.organization} (${policy.path}).`,
    ...(document.supportUrl === undefined ? [] : [`Support: ${document.supportUrl}`]),
    "",
    settings.length === 0 ? "No managed settings." : "Settings:",
    ...settings.map(
      ([path, setting]) =>
        `  ${path} = ${JSON.stringify(setting.value)} (${setting.locked ? "locked" : "default"})`,
    ),
  ];
  const {
    settings: _settings,
    organization: _organization,
    supportUrl: _supportUrl,
    schemaVersion: _version,
    ...rest
  } = document;
  if (Object.keys(rest).length > 0) {
    lines.push("", "Limits:", JSON.stringify(rest, null, 2));
  }
  return `${lines.join("\n")}\n`;
};

const showCommand = Command.make("show").pipe(
  Command.withDescription("Show the policy that applies to T3 Code on this machine."),
  Command.withHandler(() =>
    ManagedPolicy.ManagedPolicy.pipe(
      Effect.flatMap((policy) => Console.log(describePolicy(policy))),
      Effect.provide(ManagedPolicy.layer),
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
      yield* Console.log(describePolicy(yield* ManagedPolicy.load(file)));
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
      const crypto = yield* Crypto.Crypto;
      const profile = macosProfile(document, {
        profile: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
        payload: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
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
