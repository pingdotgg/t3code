/**
 * `t3 remote-control` (alias `rc`) — launch the real `claude` CLI in Remote
 * Control mode using a T3-selected Claude HOME/account.
 *
 * Remote Control is CLI-only and not exposed by the Agent SDK that T3 normally
 * uses to drive Claude, so this command spawns the official `claude` binary in
 * RC mode (`claude remote-control` for server/background, `claude
 * --remote-control` for interactive) with the resolved Claude environment and
 * inherited stdio, then waits for it to exit. It requires a claude.ai OAuth
 * login (Pro/Max/Team/Enterprise), NOT an API key; Anthropic relays the session
 * to the Claude mobile/web app — T3 builds no relay.
 *
 * Exported as `remoteControlCommand` for registration in `bin.ts` (HELM owns
 * `bin.ts`; BEACON only exports the command — contract C4).
 *
 * @module cli/remoteControl
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import {
  DEFAULT_REMOTE_CONTROL_MODE,
  launchClaudeRemoteControl,
  type ClaudeRemoteControlSettings,
  type RemoteControlMode,
} from "../remoteControl/ClaudeRemoteControlLauncher.ts";

const REMOTE_CONTROL_LOGIN_NOTE =
  "Remote Control requires a Claude Pro/Max/Team/Enterprise login (claude.ai OAuth), not an API key.";

const mutuallyExclusiveModeMessage =
  "Use only one of --interactive or --server (they are mutually exclusive).";

class RemoteControlModeConflictError extends CliError.UserError {
  override get message(): string {
    return mutuallyExclusiveModeMessage;
  }
}

const claudeHomeFlag = Flag.string("claude-home").pipe(
  Flag.withDescription(
    "Claude HOME path for the launched session (maps to the Claude instance claudeHomePath/homePath).",
  ),
  Flag.optional,
);

const nameFlag = Flag.string("name").pipe(
  Flag.withDescription("Optional session title passed through as `--name <title>`."),
  Flag.optional,
);

const interactiveFlag = Flag.boolean("interactive").pipe(
  Flag.withDescription("Run an attached interactive session (`claude --remote-control`)."),
  Flag.withDefault(false),
);

const serverFlag = Flag.boolean("server").pipe(
  Flag.withDescription("Run in server/background mode (`claude remote-control`). This is the default."),
  Flag.withDefault(false),
);

const resolveRemoteControlMode = (input: {
  readonly interactive: boolean;
  readonly server: boolean;
}): Effect.Effect<RemoteControlMode, RemoteControlModeConflictError> => {
  if (input.interactive && input.server) {
    return Effect.fail(
      new RemoteControlModeConflictError({ cause: mutuallyExclusiveModeMessage }),
    );
  }
  if (input.interactive) {
    return Effect.succeed("interactive");
  }
  if (input.server) {
    return Effect.succeed("server");
  }
  return Effect.succeed(DEFAULT_REMOTE_CONTROL_MODE);
};

export const remoteControlCommand = Command.make("remote-control", {
  claudeHome: claudeHomeFlag,
  name: nameFlag,
  interactive: interactiveFlag,
  server: serverFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription(
      "Working directory for the Remote Control session (defaults to the current directory).",
    ),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription("Launch the Claude CLI in Remote Control mode (drive it from the Claude app)."),
  Command.withAlias("rc"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const mode = yield* resolveRemoteControlMode({
        interactive: flags.interactive,
        server: flags.server,
      });

      yield* Console.log(REMOTE_CONTROL_LOGIN_NOTE);

      // `binaryPath` stays the default `claude`; resolving a per-instance
      // binaryPath from persisted settings is out of scope for this command
      // (see swarm/BEACON.md follow-up note). `homePath` comes from
      // --claude-home and flows through `makeClaudeEnvironment` in the launcher.
      const settings: ClaudeRemoteControlSettings = {
        binaryPath: "claude",
        homePath: Option.getOrElse(flags.claudeHome, () => ""),
      };

      yield* launchClaudeRemoteControl(settings, {
        mode,
        ...(Option.isSome(flags.name) ? { name: flags.name.value } : {}),
        ...(Option.isSome(flags.cwd) ? { cwd: flags.cwd.value } : {}),
      });
    }),
  ),
);
