import * as nodePath from "node:path";

import {
  ThreadId,
  type ProviderInstanceId,
  type CopilotSettings,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import type { CopilotPrewarmPoolShape } from "./CopilotSessionPrewarmPool.ts";
import { startMcpHttpServer, type McpHttpServer, type McpServeOptions } from "../../mcpServer.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import type { McpProviderSessionConfig } from "../../mcp/McpSessionRegistry.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpNativeLoggers,
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

export const COPILOT_WORKSPACE_INSTRUCTIONS = `# T3 Code workspace handoff

- NEVER run \`git worktree add\`, \`git worktree move\`, or \`git worktree remove\` through a terminal or shell tool.
- When a task needs a new isolated checkout, call the \`create_isolated_workspace\` tool instead.
- When a task needs to use an existing worktree, call the \`switch_workspace\` tool instead.
- After either workspace tool succeeds, end the current turn. T3 Code will restart the provider in the bound workspace and continue the task automatically.
- Read-only commands such as \`git worktree list\` are allowed.
`;

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

type CopilotAcpRuntimeBaseInput = Omit<
  AcpSessionRuntimeOptions,
  "auth" | "authMethodId" | "clientCapabilities" | "clientInfo" | "modeSwitchMethod" | "spawn"
> & {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: CopilotAcpRuntimeCopilotSettings | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly baseDir?: string;
  readonly customInstructionsDir?: string;
  /** When present, a matching warmed process is adopted instead of spawning. */
  readonly prewarmPool?: CopilotPrewarmPoolShape;
};
export type CopilotAcpRuntimeInput =
  | (CopilotAcpRuntimeBaseInput & {
      readonly threadId: string;
      readonly providerInstanceId: ProviderInstanceId;
    })
  | (CopilotAcpRuntimeBaseInput & {
      readonly threadId?: undefined;
      readonly providerInstanceId?: undefined;
    });

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
  customInstructionsDir?: string,
  environment: NodeJS.ProcessEnv = process.env,
): AcpSpawnInput {
  const configuredInstructionsDirs = environment.COPILOT_CUSTOM_INSTRUCTIONS_DIRS?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const instructionsDirs = customInstructionsDir
    ? Array.from(new Set([...(configuredInstructionsDirs ?? []), customInstructionsDir]))
    : configuredInstructionsDirs;

  return {
    command: copilotSettings?.binaryPath || "copilot",
    args: ["--acp", ...buildCopilotRuntimeModeArgs(runtimeMode)],
    cwd,
    ...(instructionsDirs && instructionsDirs.length > 0
      ? {
          env: {
            COPILOT_CUSTOM_INSTRUCTIONS_DIRS: instructionsDirs.join(","),
          },
        }
      : {}),
  };
}

export const prepareCopilotCustomInstructions = Effect.fn("prepareCopilotCustomInstructions")(
  function* (stateDir: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const instructionsDir = nodePath.join(stateDir, "providers", "copilot", "instructions");
    const instructionsPath = nodePath.join(instructionsDir, "AGENTS.md");
    const currentContents = yield* fileSystem
      .readFileString(instructionsPath)
      .pipe(Effect.orElseSucceed(() => undefined));

    if (currentContents !== COPILOT_WORKSPACE_INSTRUCTIONS) {
      yield* writeFileStringAtomically({
        filePath: instructionsPath,
        contents: COPILOT_WORKSPACE_INSTRUCTIONS,
      });
    }

    return instructionsDir;
  },
);

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
  providerSession: McpProviderSessionConfig | undefined,
): ReadonlyArray<EffectAcpSchema.McpServer> {
  const servers: Array<EffectAcpSchema.McpServer> = [
    {
      type: "http",
      name: "t3-tools",
      url: server.url,
      headers: [{ name: "Authorization", value: server.authorization }],
    },
  ];

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

export const logMissingCopilotMcpProviderSession = (
  threadId: string,
  providerInstanceId: ProviderInstanceId,
) =>
  Effect.logWarning("copilot.mcp.provider-session-missing", {
    threadId,
    providerInstanceId,
  });

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

export const COPILOT_ACP_AUTH_OPTIONS = {
  methodId: COPILOT_AUTH_METHOD_ID,
  required: true,
  missingMessage:
    'GitHub Copilot ACP did not advertise the expected login method. Run "copilot login" in a terminal, then try again.',
} as const;

/**
 * Runtime options that do not depend on a thread. Shared with the prewarm pool
 * so a warmed process is byte-for-byte the process a session would have built.
 */
export const COPILOT_ACP_SHARED_RUNTIME_OPTIONS = {
  auth: COPILOT_ACP_AUTH_OPTIONS,
  clientInfo: COPILOT_CLIENT_INFO,
  clientCapabilities: COPILOT_CLIENT_CAPABILITIES,
  modeSwitchMethod: "set_mode",
} as const;

/**
 * Binds a prewarmed process to a thread. The warmed process was created without
 * a thread, so it holds neither an MCP credential nor thread-scoped loggers:
 * `session/new` must be given this thread's servers, nothing may override them
 * (otherwise a warmed process could carry another thread's credential), and the
 * thread's native loggers must be installed or the adopted session would emit
 * no ACP request/protocol events for its whole lifetime.
 */
export const bindPrewarmedCopilotRuntime = (
  pooled: AcpSessionRuntimeShape,
  mcpServers: ReturnType<typeof buildCopilotMcpServers>,
  nativeLoggers: AcpNativeLoggers,
): Effect.Effect<AcpSessionRuntimeShape> =>
  pooled.bindNativeLoggers(nativeLoggers).pipe(
    Effect.as({
      ...pooled,
      start: (overrides) => pooled.start({ ...overrides, mcpServers }),
    } satisfies AcpSessionRuntimeShape),
  );

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
    const providerSession = input.threadId
      ? yield* McpSessionRegistry.readActiveMcpProviderSession(
          ThreadId.make(input.threadId),
          input.providerInstanceId,
        )
      : undefined;
    if (input.threadId && !providerSession) {
      yield* logMissingCopilotMcpProviderSession(input.threadId, input.providerInstanceId);
    }
    const spawn = buildCopilotAcpSpawnInput(
      input.copilotSettings,
      input.cwd,
      input.runtimeMode,
      input.customInstructionsDir,
    );
    // The MCP servers carry this thread's credential, so they are supplied at
    // `session/new` time rather than baked into the process.
    const mcpServers = buildCopilotMcpServers(mcpHttpServer, providerSession);

    // A resumed session replays a specific session id; only fresh sessions can
    // adopt a warmed process.
    const pooled =
      input.resumeSessionId || !input.prewarmPool
        ? undefined
        : yield* input.prewarmPool.acquire(spawn);

    if (pooled) {
      yield* Effect.logDebug("copilot acp runtime adopted prewarmed process", {
        threadId: input.threadId,
        cwd: input.cwd,
      });
      return yield* bindPrewarmedCopilotRuntime(pooled, mcpServers, {
        ...(input.requestLogger ? { requestLogger: input.requestLogger } : {}),
        ...(input.protocolLogging ? { protocolLogging: input.protocolLogging } : {}),
      });
    }

    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn,
        ...COPILOT_ACP_SHARED_RUNTIME_OPTIONS,
        mcpServers,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
