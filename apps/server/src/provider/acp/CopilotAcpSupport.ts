import {
  type CopilotSettings,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export const COPILOT_AUTH_METHOD_ID = "copilot-login";

export const COPILOT_CLIENT_INFO = {
  name: "t3-code",
  version: "0.0.0",
} as const;

export const COPILOT_AGENT_MODE_ID = "https://agentclientprotocol.com/protocol/session-modes#agent";
export const COPILOT_PLAN_MODE_ID = "https://agentclientprotocol.com/protocol/session-modes#plan";

export const COPILOT_LEGACY_AGENT_MODE_ID = "https://github.com/github/copilot-cli/mode#agent";
export const COPILOT_LEGACY_AUTOPILOT_MODE_ID =
  "https://github.com/github/copilot-cli/mode#autopilot";
export const COPILOT_LEGACY_PLAN_MODE_ID = "https://github.com/github/copilot-cli/mode#plan";

export const COPILOT_CLIENT_CAPABILITIES = {
  fs: {
    readTextFile: false,
    writeTextFile: false,
  },
  elicitation: {
    form: {},
    url: {},
  },
  terminal: false,
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

const COPILOT_MCP_TOOLSETS = [
  "terminal",
  "read_file",
  "write_file",
  "search_files",
  "skill_view",
  "skills_list",
  "skill_manage",
  "web_search",
  "web_extract",
  "memory",
] as const;

type CopilotAcpRuntimeCopilotSettings = {
  readonly binaryPath: CopilotSettings["binaryPath"];
};

export interface CopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "auth" | "authMethodId" | "clientCapabilities" | "clientInfo" | "modeSwitchMethod" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined;
  readonly runtimeMode: RuntimeMode;
}

export function buildCopilotRuntimeModeArgs(runtimeMode: RuntimeMode): ReadonlyArray<string> {
  return runtimeMode === "full-access" ? ["--allow-all"] : [];
}

export function buildCopilotAcpSpawnInput(
  copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined,
  cwd: string,
  runtimeMode: RuntimeMode,
): AcpSpawnInput {
  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: ["--acp", ...buildCopilotRuntimeModeArgs(runtimeMode)],
    cwd,
  };
}

export function buildCopilotMcpServers(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<EffectAcpSchema.McpServer> {
  if (env.T3_COPILOT_ACP_ENABLE_MCP !== "1" && env.HERMES_COPILOT_ACP_ENABLE_MCP !== "1") {
    return [];
  }

  const command =
    env.T3_COPILOT_ACP_MCP_COMMAND?.trim() || env.HERMES_COPILOT_ACP_MCP_COMMAND?.trim() || "t3";
  const toolsets =
    env.T3_COPILOT_ACP_MCP_TOOLSETS?.trim() ||
    env.HERMES_COPILOT_ACP_MCP_TOOLSETS?.trim() ||
    COPILOT_MCP_TOOLSETS.join(",");
  return [
    {
      name: "t3-tools",
      command,
      args: ["mcp", "serve", "--cwd", cwd, "--toolsets", toolsets],
      env: [],
    },
  ];
}

export function resolveCopilotAcpModeId(
  interactionMode: ProviderInteractionMode | null | undefined,
): typeof COPILOT_AGENT_MODE_ID | typeof COPILOT_PLAN_MODE_ID {
  return interactionMode === "plan" ? COPILOT_PLAN_MODE_ID : COPILOT_AGENT_MODE_ID;
}

export function normalizeCopilotAcpModeId(modeId: string | null | undefined): string | undefined {
  const normalized = modeId?.trim();
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case COPILOT_AGENT_MODE_ID:
    case COPILOT_PLAN_MODE_ID:
      return normalized;
    case COPILOT_LEGACY_AGENT_MODE_ID:
    case COPILOT_LEGACY_AUTOPILOT_MODE_ID:
      return COPILOT_AGENT_MODE_ID;
    case COPILOT_LEGACY_PLAN_MODE_ID:
      return COPILOT_PLAN_MODE_ID;
    default:
      return normalized;
  }
}

export function isCopilotPlanModeId(modeId: string | null | undefined): boolean {
  return normalizeCopilotAcpModeId(modeId) === COPILOT_PLAN_MODE_ID;
}

export const makeCopilotAcpRuntime = (
  input: CopilotAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCopilotAcpSpawnInput(input.copilotSettings, input.cwd, input.runtimeMode),
        auth: {
          methodId: COPILOT_AUTH_METHOD_ID,
          required: true,
          missingMessage:
            'GitHub Copilot ACP did not advertise the expected login method. Run "copilot login" in a terminal, then try again.',
        },
        clientInfo: COPILOT_CLIENT_INFO,
        clientCapabilities: COPILOT_CLIENT_CAPABILITIES,
        modeSwitchMethod: "set_mode",
        mcpServers: buildCopilotMcpServers(input.cwd),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
