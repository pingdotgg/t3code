import {
  ThreadId,
  type CopilotSettings,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { startMcpHttpServer, type McpHttpServer, type McpServeOptions } from "../../mcpServer.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
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
  "preview_screenshot",
  "preview_click",
  "preview_type",
  "preview_annotate",
  "create_isolated_workspace",
  "switch_workspace",
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
  readonly threadId?: string;
  readonly baseDir?: string;
}

export function buildCopilotRuntimeModeArgs(_runtimeMode: RuntimeMode): ReadonlyArray<string> {
  // Keep permission requests flowing through ACP in every runtime mode. T3
  // still auto-approves normal full-access requests, but must be able to gate
  // workspace-changing commands such as raw `git worktree add`.
  return [];
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

export function buildCopilotMcpServerOptions(
  cwd: string,
  threadId: string | undefined,
  cliBaseDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  runtime: {
    readonly execPath: string;
    readonly entryPath: string | undefined;
  } = { execPath: process.execPath, entryPath: process.argv[1] },
): McpServeOptions {
  const configuredCommand =
    env.T3_COPILOT_ACP_MCP_COMMAND?.trim() || env.HERMES_COPILOT_ACP_MCP_COMMAND?.trim();
  const commandArgsPrefix =
    configuredCommand === undefined && runtime.entryPath !== undefined ? [runtime.entryPath] : [];
  const command = configuredCommand ?? (commandArgsPrefix.length > 0 ? runtime.execPath : "t3");
  const mcpEnabled =
    env.T3_COPILOT_ACP_ENABLE_MCP === "1" || env.HERMES_COPILOT_ACP_ENABLE_MCP === "1";
  const configuredToolsets =
    env.T3_COPILOT_ACP_MCP_TOOLSETS?.trim() || env.HERMES_COPILOT_ACP_MCP_TOOLSETS?.trim();
  const toolsetNames = new Set(
    (configuredToolsets ?? (mcpEnabled ? COPILOT_MCP_TOOLSETS.join(",") : ""))
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  toolsetNames.add("create_isolated_workspace");
  toolsetNames.add("switch_workspace");
  return {
    cwd,
    toolsets: toolsetNames,
    threadId,
    cliCommand: command,
    ...(commandArgsPrefix.length > 0 ? { cliArgsPrefix: commandArgsPrefix } : {}),
    ...(cliBaseDir ? { cliBaseDir } : {}),
  };
}

export function buildCopilotMcpServers(
  server: Pick<McpHttpServer, "authorization" | "url">,
  threadId?: string,
): ReadonlyArray<EffectAcpSchema.McpServer> {
  const servers: Array<EffectAcpSchema.McpServer> = [
    {
      type: "http",
      name: "t3-tools",
      url: server.url,
      headers: [{ name: "Authorization", value: server.authorization }],
    },
  ];

  const providerSession = threadId
    ? McpProviderSession.readMcpProviderSession(ThreadId.make(threadId))
    : undefined;
  if (providerSession) {
    servers.push({
      type: "http",
      name: "t3-code",
      url: providerSession.endpoint,
      headers: [
        {
          name: "Authorization",
          value: providerSession.authorizationHeader,
        },
      ],
    });
  }

  return servers;
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
    const mcpHttpServer = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startMcpHttpServer(
            buildCopilotMcpServerOptions(input.cwd, input.threadId, input.baseDir),
          ),
        catch: (cause) =>
          new EffectAcpErrors.AcpSpawnError({
            command: "T3 MCP HTTP server",
            cause,
          }),
      }),
      (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
    );
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
        mcpServers: buildCopilotMcpServers(mcpHttpServer, input.threadId),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
