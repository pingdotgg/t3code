import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  EnvironmentAuthorizationError,
  OrchestratorMcpFailure,
  TerminalCwdStatError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export const TEAM_HUB_ONLY_AGENT_ERROR_MESSAGE =
  "This server is running in --team-hub-only control-plane mode and cannot spawn coding agents locally. Run threads on an attached runner environment (such as t3runner).";

const TEAM_HUB_ONLY_TERMINAL_ERROR_MESSAGE =
  "This server is running in --team-hub-only control-plane mode and cannot spawn local shell terminals. Open terminals on an attached runner environment (such as t3runner).";

export class TeamHubOnlyExecutionRefusedError extends Schema.TaggedError<TeamHubOnlyExecutionRefusedError>()(
  "TeamHubOnlyExecutionRefusedError",
  {
    operation: Schema.Literals(["agent", "terminal"]),
    message: Schema.String,
  },
) {}

export const isTeamHubOnlyServer = Effect.serviceOption(ServerConfig.ServerConfig).pipe(
  Effect.map((config) => Option.isSome(config) && config.value.teamHubOnly === true),
);

export const assertLocalAgentRpcExecutionAllowed = isTeamHubOnlyServer.pipe(
  Effect.flatMap((hubOnly) =>
    hubOnly
      ? Effect.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            requiredPermission: "team:hub_runner_required",
            message: TEAM_HUB_ONLY_AGENT_ERROR_MESSAGE,
          }),
        )
      : Effect.void,
  ),
);

export const assertLocalAgentMcpExecutionAllowed = isTeamHubOnlyServer.pipe(
  Effect.flatMap((hubOnly) =>
    hubOnly
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: TEAM_HUB_ONLY_AGENT_ERROR_MESSAGE,
          }),
        )
      : Effect.void,
  ),
);

export const assertLocalTerminalRpcExecutionAllowed = isTeamHubOnlyServer.pipe(
  Effect.flatMap((hubOnly) =>
    hubOnly
      ? Effect.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthTerminalOperateScope,
            requiredPermission: "team:hub_runner_required",
            message: TEAM_HUB_ONLY_TERMINAL_ERROR_MESSAGE,
          }),
        )
      : Effect.void,
  ),
);

export const teamHubOnlyTerminalError = (cwd: string) =>
  new TerminalCwdStatError({
    cwd,
    cause: new TeamHubOnlyExecutionRefusedError({
      operation: "terminal",
      message: TEAM_HUB_ONLY_TERMINAL_ERROR_MESSAGE,
    }),
  });
