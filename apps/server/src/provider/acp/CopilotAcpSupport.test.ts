import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { Effect, FileSystem, Logger, Path } from "effect";
import { HttpServer } from "effect/unstable/http";

import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  COPILOT_AGENT_MODE_ID,
  COPILOT_LEGACY_AGENT_MODE_ID,
  COPILOT_LEGACY_AUTOPILOT_MODE_ID,
  COPILOT_LEGACY_PLAN_MODE_ID,
  COPILOT_PLAN_MODE_ID,
  COPILOT_WORKSPACE_INSTRUCTIONS,
  buildCopilotRuntimeModeArgs,
  buildCopilotAcpSpawnInput,
  buildCopilotMcpServerOptions,
  buildCopilotMcpServers,
  bindPrewarmedCopilotRuntime,
  isCopilotPlanModeId,
  logMissingCopilotMcpProviderSession,
  normalizeCopilotAcpModeId,
  prepareCopilotCustomInstructions,
  resolveCopilotAcpModeId,
} from "./CopilotAcpSupport.ts";

const makeFakeHttpServer = () =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeEnvironment = ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
  getDescriptor: Effect.die("unused"),
});

describe("buildCopilotAcpSpawnInput", () => {
  it("builds the default GitHub Copilot ACP command", () => {
    expect(
      buildCopilotAcpSpawnInput(undefined, "/tmp/project", "approval-required", undefined, {}),
    ).toEqual({
      command: "copilot",
      args: ["--acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured binary path", () => {
    expect(
      buildCopilotAcpSpawnInput(
        { binaryPath: "/opt/bin/copilot" },
        "/tmp/project",
        "full-access",
        undefined,
        {},
      ),
    ).toEqual({
      command: "/opt/bin/copilot",
      args: ["--acp"],
      cwd: "/tmp/project",
    });
  });

  it("adds T3 workspace instructions without replacing configured instruction directories", () => {
    expect(
      buildCopilotAcpSpawnInput(undefined, "/tmp/project", "full-access", "/tmp/t3-instructions", {
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/tmp/user-instructions,/tmp/t3-instructions",
      }),
    ).toEqual({
      command: "copilot",
      args: ["--acp"],
      cwd: "/tmp/project",
      env: {
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/tmp/user-instructions,/tmp/t3-instructions",
      },
    });
  });

  it.effect("writes the T3 workspace policy as Copilot custom instructions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-copilot-instructions-",
      });

      const instructionsDir = yield* prepareCopilotCustomInstructions(stateDir);
      expect(instructionsDir).toBe(path.join(stateDir, "providers", "copilot", "instructions"));
      expect(yield* fileSystem.readFileString(path.join(instructionsDir, "AGENTS.md"))).toBe(
        COPILOT_WORKSPACE_INSTRUCTIONS,
      );
      expect(COPILOT_WORKSPACE_INSTRUCTIONS).toContain(
        "NEVER run `git worktree add`, `git worktree move`, or `git worktree remove`",
      );
      expect(COPILOT_WORKSPACE_INSTRUCTIONS).toContain("`create_isolated_workspace`");
      expect(COPILOT_WORKSPACE_INSTRUCTIONS).toContain("`switch_workspace`");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  describe("buildCopilotMcpServers", () => {
    it("exposes the workspace handoff tool by default", () => {
      expect(
        buildCopilotMcpServerOptions(
          "/tmp/project",
          "thread-1",
          ProviderInstanceId.make("copilot-team"),
          "/tmp/t3-dev",
          "approval-required",
          {},
          {
            execPath: "/usr/bin/node",
            entryPath: "/app/bin.mjs",
          },
        ),
      ).toEqual({
        cwd: "/tmp/project",
        toolsets: new Set([
          "create_isolated_workspace",
          "switch_workspace",
          "create_nested_thread",
        ]),
        threadId: "thread-1",
        cliCommand: "/usr/bin/node",
        providerInstanceId: ProviderInstanceId.make("copilot-team"),
        cliArgsPrefix: ["/app/bin.mjs"],
        cliBaseDir: "/tmp/t3-dev",
        runtimeMode: "approval-required",
      });

      expect(
        buildCopilotMcpServers(
          {
            url: "http://127.0.0.1:1234/mcp",
            authorization: "Bearer secret",
          },
          undefined,
        ),
      ).toEqual([
        {
          type: "http",
          name: "t3-tools",
          url: "http://127.0.0.1:1234/mcp",
          headers: [{ name: "Authorization", value: "Bearer secret" }],
        },
      ]);
    });

    it("builds env-gated T3 MCP HTTP server options", () => {
      expect(
        buildCopilotMcpServerOptions(
          "/tmp/project",
          "thread-1",
          ProviderInstanceId.make("copilot-team"),
          "/tmp/t3-dev",
          "auto-accept-edits",
          {
            T3_COPILOT_ACP_ENABLE_MCP: "1",
            T3_COPILOT_ACP_MCP_COMMAND: "t3-dev",
            T3_COPILOT_ACP_MCP_TOOLSETS: "read_file,search_files",
          },
        ),
      ).toEqual({
        cwd: "/tmp/project",
        toolsets: new Set([
          "read_file",
          "search_files",
          "create_isolated_workspace",
          "switch_workspace",
          "create_nested_thread",
        ]),
        threadId: "thread-1",
        cliCommand: "t3-dev",
        providerInstanceId: ProviderInstanceId.make("copilot-team"),
        cliBaseDir: "/tmp/t3-dev",
        runtimeMode: "auto-accept-edits",
      });
    });

    it.effect("appends the provider-scoped browser automation server from the registry", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-1");
        const providerInstanceId = ProviderInstanceId.make("copilot");
        const registry = yield* McpSessionRegistry.__testing
          .make()
          .pipe(
            Effect.provideService(HttpServer.HttpServer, makeFakeHttpServer()),
            Effect.provideService(ServerEnvironment, fakeEnvironment),
            Effect.provide(NodeServices.layer),
          );
        const issued = yield* registry.issue({ threadId, providerInstanceId });
        const providerSession = yield* registry.readProviderSession(threadId, providerInstanceId);
        expect(providerSession).toBe(issued.config);
        if (!providerSession) {
          return;
        }

        expect(
          buildCopilotMcpServers(
            {
              url: "http://127.0.0.1:1234/mcp",
              authorization: "t3-tools-token",
            },
            providerSession,
          ),
        ).toEqual([
          {
            type: "http",
            name: "t3-tools",
            url: "http://127.0.0.1:1234/mcp",
            headers: [{ name: "Authorization", value: "t3-tools-token" }],
          },
          {
            type: "http",
            name: "t3-code",
            url: providerSession.endpoint,
            headers: [{ name: "Authorization", value: providerSession.authorizationHeader }],
          },
        ]);
      }),
    );
  });
});

describe("buildCopilotRuntimeModeArgs", () => {
  it.effect("logs a missing provider MCP session at spawn", () => {
    const messages: Array<string> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    return logMissingCopilotMcpProviderSession(
      "thread-missing-provider-session",
      ProviderInstanceId.make("copilot"),
    ).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(messages).toContainEqual(
            expect.stringContaining("copilot.mcp.provider-session-missing"),
          );
        }),
      ),
    );
  });

  it("keeps ACP permission interception active in full-access mode", () => {
    expect(buildCopilotRuntimeModeArgs("full-access")).toEqual([]);
  });

  it("does not add startup args for stricter runtime modes", () => {
    expect(buildCopilotRuntimeModeArgs("approval-required")).toEqual([]);
    expect(buildCopilotRuntimeModeArgs("auto-accept-edits")).toEqual([]);
  });
});

describe("Copilot ACP mode ids", () => {
  it("maps T3 Code interaction modes to Copilot ACP session mode URIs", () => {
    expect(resolveCopilotAcpModeId("default")).toBe(COPILOT_AGENT_MODE_ID);
    expect(resolveCopilotAcpModeId(undefined)).toBe(COPILOT_AGENT_MODE_ID);
    expect(resolveCopilotAcpModeId("plan")).toBe(COPILOT_PLAN_MODE_ID);
  });

  it("normalizes canonical and legacy Copilot mode URIs", () => {
    expect(normalizeCopilotAcpModeId(COPILOT_AGENT_MODE_ID)).toBe(COPILOT_AGENT_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_PLAN_MODE_ID)).toBe(COPILOT_PLAN_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_LEGACY_AGENT_MODE_ID)).toBe(COPILOT_AGENT_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_LEGACY_AUTOPILOT_MODE_ID)).toBe(COPILOT_AGENT_MODE_ID);
    expect(normalizeCopilotAcpModeId(COPILOT_LEGACY_PLAN_MODE_ID)).toBe(COPILOT_PLAN_MODE_ID);
    expect(normalizeCopilotAcpModeId("custom-mode")).toBe("custom-mode");
    expect(normalizeCopilotAcpModeId("  ")).toBeUndefined();
  });

  it("detects plan mode after legacy URI normalization", () => {
    expect(isCopilotPlanModeId(COPILOT_LEGACY_PLAN_MODE_ID)).toBe(true);
    expect(isCopilotPlanModeId(COPILOT_LEGACY_AGENT_MODE_ID)).toBe(false);
  });
});

describe("bindPrewarmedCopilotRuntime", () => {
  const makePooledRuntime = () => {
    const starts: Array<unknown> = [];
    const bound: Array<unknown> = [];
    const runtime = {
      start: (overrides?: unknown) => {
        starts.push(overrides);
        return Effect.void;
      },
      bindNativeLoggers: (loggers: unknown) => {
        bound.push(loggers);
        return Effect.void;
      },
      warmup: Effect.void,
    } as unknown as Parameters<typeof bindPrewarmedCopilotRuntime>[0];
    return { runtime, starts, bound };
  };

  const threadMcpServers = [
    { name: "t3-code", url: "http://127.0.0.1:1/mcp", headers: [] },
  ] as unknown as ReturnType<typeof buildCopilotMcpServers>;

  const noLoggers = {} as Parameters<typeof bindPrewarmedCopilotRuntime>[2];

  it("supplies this thread's MCP servers at session/new", () =>
    Effect.gen(function* () {
      const { runtime, starts } = makePooledRuntime();

      const bound = yield* bindPrewarmedCopilotRuntime(runtime, threadMcpServers, noLoggers);
      yield* bound.start();

      expect(starts).toHaveLength(1);
      expect((starts[0] as { mcpServers: unknown }).mcpServers).toBe(threadMcpServers);
    }).pipe(Effect.runPromise));

  it("refuses to let overrides replace the thread's MCP credential", () =>
    Effect.gen(function* () {
      const { runtime, starts } = makePooledRuntime();
      const otherThreadServers = [
        { name: "t3-code", url: "http://127.0.0.1:2/mcp", headers: [] },
      ] as unknown as ReturnType<typeof buildCopilotMcpServers>;

      const bound = yield* bindPrewarmedCopilotRuntime(runtime, threadMcpServers, noLoggers);
      yield* bound.start({ mcpServers: otherThreadServers });

      expect((starts[0] as { mcpServers: unknown }).mcpServers).toBe(threadMcpServers);
    }).pipe(Effect.runPromise));

  it("installs the adopting thread's native loggers", () =>
    Effect.gen(function* () {
      const { runtime, bound } = makePooledRuntime();
      const loggers = {
        requestLogger: () => Effect.void,
        protocolLogging: { logIncoming: true, logOutgoing: true, logger: () => Effect.void },
      } as unknown as Parameters<typeof bindPrewarmedCopilotRuntime>[2];

      yield* bindPrewarmedCopilotRuntime(runtime, threadMcpServers, loggers);

      expect(bound).toEqual([loggers]);
    }).pipe(Effect.runPromise));
});
