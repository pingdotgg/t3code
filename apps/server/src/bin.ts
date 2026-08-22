import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Argument, Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { connectCommand } from "./cli/connect.ts";
import { tryLaunchDesktopApp } from "./cli/desktopLaunch.ts";
import { pairCommand } from "./cli/pair.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { openLiveProjectIfPresent, projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { serviceCommand } from "./cli/service.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";
import { triageCommand } from "./cli/triage.ts";

const DESKTOP_OPEN_POLL_ATTEMPTS = 40;
const DESKTOP_OPEN_POLL_DELAY = Duration.millis(500);

const openProjectViaDesktopOrLiveServer = Effect.fn("openProjectViaDesktopOrLiveServer")(
  function* (flags: {
    readonly baseDir: Option.Option<string>;
    readonly cwd: Option.Option<string>;
  }) {
    // Already attached to whatever is serving this home (CLI or desktop backend).
    // Never clear discovery here: a transient miss must not delete a live
    // desktop/server runtime file before we launch/poll.
    if (yield* openLiveProjectIfPresent({ ...flags, clearOnFailure: false })) {
      return true;
    }

    // No live backend: try the installed desktop app, then attach once it is up.
    if (!(yield* tryLaunchDesktopApp())) {
      return false;
    }

    for (let attempt = 0; attempt < DESKTOP_OPEN_POLL_ATTEMPTS; attempt += 1) {
      yield* Effect.sleep(DESKTOP_OPEN_POLL_DELAY);
      if (yield* openLiveProjectIfPresent({ ...flags, clearOnFailure: false })) {
        return true;
      }
    }

    yield* Console.error(
      "Launched T3 Code desktop, but it did not become ready in time. Falling back to the CLI server.",
    );
    return false;
  },
);

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const connectPublicConfigMissingMessage =
  "T3 Connect commands are unavailable: this build is missing T3 Connect public configuration.";

class ConnectPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return connectPublicConfigMissingMessage;
  }
}

const connectUnavailableCommand = Command.make("connect", {
  command: Argument.string("command").pipe(Argument.variadic),
}).pipe(
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
    Command.withDescription(
      "Run the T3 Code server, or open a directory in the desktop app / a running server.",
    ),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const cwd = flags.cwd ?? Option.none();
        if (
          Option.isSome(cwd) &&
          (yield* openProjectViaDesktopOrLiveServer({
            baseDir: flags.baseDir ?? Option.none(),
            cwd,
          }))
        ) {
          return;
        }
        return yield* runServerCommand(flags);
      }),
    ),
    Command.withSubcommands([
      startCommand,
      serveCommand,
      pairCommand,
      authCommand,
      projectCommand,
      serviceCommand,
      servicePreflightCommand,
      triageCommand,
      cloudEnabled ? connectCommand : connectUnavailableCommand,
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
