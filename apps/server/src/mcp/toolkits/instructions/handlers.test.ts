import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  InstructionAgentsResult,
  InstructionListResult,
  InstructionReadResult,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type RuntimeMode,
} from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import { layerFor, makeMachine, makeProject } from "../../../instructions/testing/machine.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const threadId = ThreadId.make("instructions-mcp-thread");
const projectId = ProjectId.make("project-instructions");
const callingInstance = ProviderInstanceId.make("codex");

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "instructions-mcp", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "instructions-mcp", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("instructions-mcp-environment"),
  requestNamespace: "instructions-mcp-session",
  thread: {
    threadId,
    providerSessionId: "instructions-mcp-session",
    providerInstanceId: callingInstance,
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// Effect returns a declared tool failure as `isError` with its encoded payload as JSON text.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? decodeJson(text.text) : undefined;
};

/** The production instructions registration over the real catalog and manager at `home`. */
const mcpLayerFor = (
  home: string,
  project: string,
  options: { readonly runtimeMode?: RuntimeMode } = {},
) =>
  McpHttpServer.layerInstructionsToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(layerFor(home, { registered: [project], versions: { claudeAgent: "2.1.291" } })),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(id === projectId ? Option.some(makeProject(project)) : Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            projectId,
            providerInstanceId: callingInstance,
            runtimeMode: options.runtimeMode ?? "full-access",
            interactionMode: "default",
            activeRunId: RunId.make("instructions-mcp-run"),
            archivedAt: null,
            deletedAt: null,
          } as OrchestrationV2ThreadShell),
      }),
    ),
  );

const call = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const decodeList = Schema.decodeUnknownSync(InstructionListResult);
const decodeRead = Schema.decodeUnknownSync(InstructionReadResult);
const decodeAgents = Schema.decodeUnknownSync(InstructionAgentsResult);

describe("instructions MCP tools", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })("over a real layout", (it) => {
    it.effect("lists the calling thread's project files and the global ones", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "project rules");
        yield* write(".codex/AGENTS.md", "codex notes");
        yield* Effect.gen(function* () {
          const result = decodeList((yield* call("t3_instructions_list", {})).structuredContent);

          // CLAUDE.local.md is listed while missing, like the project's AGENTS.md was.
          expect(result.entries.map((entry) => entry.id)).toEqual([
            "project:shared:AGENTS.md",
            "project:claudeLocal:CLAUDE.local.md",
            "global:shared",
            "global:agentOwn:codex",
          ]);
          expect(result.sharedPath).toBe(`${home}/.agents/AGENTS.md`);
        }).pipe(Effect.provide(mcpLayerFor(home, project)));
      }),
    );

    it.effect("reads one file's text by the id the list gave", () =>
      Effect.gen(function* () {
        const { home, project, write } = yield* makeMachine;
        yield* write("repos/app/AGENTS.md", "project rules");
        yield* Effect.gen(function* () {
          const result = decodeRead(
            (yield* call("t3_instructions_get", { id: "project:shared:AGENTS.md" }))
              .structuredContent,
          );
          expect(result).toMatchObject({ contents: "project rules", tooLarge: false });

          const missing = yield* call("t3_instructions_get", { id: "global:shared" });
          expect(decodeRead(missing.structuredContent)).toMatchObject({
            contents: null,
            revision: null,
          });

          const unknown = yield* call("t3_instructions_get", { id: "project:claude:README.md" });
          expect(declaredFailure(unknown)).toMatchObject({ code: "invalid_request" });
        }).pipe(Effect.provide(mcpLayerFor(home, project)));
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "turns the shared file on for named agents, and off again",
      () =>
        Effect.gen(function* () {
          const { home, project, fs, path, write, read } = yield* makeMachine;
          yield* write(".claude/CLAUDE.md", "my notes\n");
          yield* Effect.gen(function* () {
            const on = yield* call("t3_instructions_enable", {
              agents: ["codex", "claudeAgent"],
            });
            expect(on.isError).toBe(false);
            expect(decodeAgents(on.structuredContent).results).toEqual([
              { instanceId: "codex", outcome: "changed" },
              { instanceId: "claudeAgent", outcome: "changed" },
            ]);
            expect(yield* fs.readLink(path.join(home, ".codex/AGENTS.md"))).toBe(
              path.join(home, ".agents/AGENTS.md"),
            );
            expect(yield* read(".claude/CLAUDE.md")).toBe("@~/.agents/AGENTS.md\nmy notes\n");

            const off = yield* call("t3_instructions_disable", { agents: ["codex"] });
            expect(decodeAgents(off.structuredContent).results).toEqual([
              { instanceId: "codex", outcome: "changed" },
            ]);
            expect(yield* fs.exists(path.join(home, ".codex/AGENTS.md"))).toBe(false);
            // The shared file stays.
            expect(yield* fs.exists(path.join(home, ".agents/AGENTS.md"))).toBe(true);
          }).pipe(Effect.provide(mcpLayerFor(home, project)));
        }),
    );

    it.effect("lets a supervised thread read instructions but not change who reads them", () =>
      Effect.gen(function* () {
        const { home, project, fs, path } = yield* makeMachine;
        yield* Effect.gen(function* () {
          expect((yield* call("t3_instructions_list", {})).isError).toBe(false);

          for (const [name, args] of [
            ["t3_instructions_enable", { agents: "all" }],
            ["t3_instructions_disable", { agents: ["codex"] }],
          ] as const) {
            const result = yield* call(name, args);
            expect(declaredFailure(result), name).toMatchObject({ code: "capability_denied" });
          }
          expect(yield* fs.exists(path.join(home, ".codex"))).toBe(false);
        }).pipe(Effect.provide(mcpLayerFor(home, project, { runtimeMode: "approval-required" })));
      }),
    );

    it.effect("rejects inputs the tools do not accept before touching any service", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* Effect.gen(function* () {
          for (const [name, args] of [
            ["t3_instructions_enable", { agents: [] }],
            ["t3_instructions_enable", { agents: ["not a slug"] }],
            // Only enabling takes "all".
            ["t3_instructions_disable", { agents: "all" }],
            ["t3_instructions_get", {}],
            ["t3_instructions_get", { id: "" }],
          ] as const) {
            const error = yield* call(name, args).pipe(Effect.flip);
            expect(error._tag, `${name} ${Object.keys(args).join()}`).toBe("InvalidParams");
          }
        }).pipe(Effect.provide(mcpLayerFor(home, project)));
      }),
    );
  });
});
