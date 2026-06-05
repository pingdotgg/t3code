import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { cloudCommand } from "./cli/cloud.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const cloudPublicConfigMissingMessage =
  "T3 Cloud commands are unavailable: this build is missing T3 Cloud public configuration.";

class CloudPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return cloudPublicConfigMissingMessage;
  }
}

const cloudUnavailableCommand = Command.make("cloud").pipe(
  Command.withDescription("T3 Cloud is unavailable in builds without public cloud configuration."),
  Command.withHidden,
  Command.withHandler(() =>
    Effect.fail(
      new CliError.ShowHelp({
        commandPath: ["t3", "cloud"],
        errors: [new CloudPublicConfigMissingError({ cause: cloudPublicConfigMissingMessage })],
      }),
    ),
  ),
);

export const makeCli = ({ cloudEnabled = hasCloudPublicConfig } = {}) =>
  Command.make("t3", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the T3 Code server."),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([
      startCommand,
      serveCommand,
      authCommand,
      projectCommand,
      cloudEnabled ? cloudCommand : cloudUnavailableCommand,
    ]),
  );

export const cli = makeCli();

if (import.meta.main) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
