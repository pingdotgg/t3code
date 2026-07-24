import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import { authCommand } from "./auth.ts";
import { connectCommand } from "./connect.ts";
import { sharedServerCommandFlags } from "./config.ts";
import { projectCommand } from "./project.ts";
import { remoteCommand } from "./remote.ts";
import { runServerCommand, serveCommand, startCommand } from "./server.ts";
import { serviceCommand } from "./service.ts";
import { hasCloudPublicConfig } from "../cloud/publicConfig.ts";

const connectPublicConfigMissingMessage =
  "T3 Connect commands are unavailable: this build is missing T3 Connect public configuration.";

class ConnectPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return connectPublicConfigMissingMessage;
  }
}

const connectUnavailableCommand = Command.make("connect").pipe(
  Command.withDescription("T3 Connect is unavailable in builds without public configuration."),
  Command.withHidden,
  Command.withHandler(() =>
    Effect.fail(
      new CliError.ShowHelp({
        commandPath: ["t3", "connect"],
        errors: [new ConnectPublicConfigMissingError({ cause: connectPublicConfigMissingMessage })],
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
      serviceCommand,
      remoteCommand,
      cloudEnabled ? connectCommand : connectUnavailableCommand,
    ]),
  );

export const cli = makeCli();
