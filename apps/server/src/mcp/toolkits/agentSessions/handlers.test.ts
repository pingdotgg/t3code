import { expect, it } from "@effect/vitest";
import {
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AuthMcpClientAccess,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AgentSessionImporter from "../../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../../project/AgentSessionScanner.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as AgentSessionsHandlers from "./handlers.ts";
import { AgentSessionsToolkit } from "./tools.ts";

const projectId = ProjectId.make("project:import");
const threadId = ThreadId.make("thread:import");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:import"),
  requestNamespace: "provider:import",
  thread: {
    threadId,
    providerSessionId: "provider:import",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const scan = {
  candidates: [
    {
      path: "/projects/example",
      title: "example",
      projectId,
      sources: ["codex" as const],
      threadCount: 2,
      lastActiveAt: "2026-11-01T00:00:00.000Z",
      alreadyImported: false,
    },
  ],
  scannedAt: "2026-11-02T00:00:00.000Z",
  truncated: true,
};

const layerDependencies = Layer.mergeAll(
  Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
  }),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({ scan: Effect.succeed(scan) }),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({
    importRecentAgentThreads: (input) => {
      if (input.projectId !== projectId) {
        return Effect.fail(
          new AgentSessionImportProjectNotFoundError({ projectId: input.projectId }),
        );
      }
      if (input.expectedWorkspaceRoot !== scan.candidates[0]!.path) {
        return Effect.fail(new AgentSessionImportProjectChangedError({ projectId }));
      }
      return Effect.succeed({ importedCount: 2, skippedCount: 1 });
    },
  }),
);
const layerToolkit = McpToolAccess.HandlersLayer.layer(AgentSessionsHandlers.layer).pipe(
  Layer.provideMerge(layerDependencies),
);

it.effect(
  "discovers history after setup and reports stale or missing projects as invalid requests",
  () =>
    Effect.gen(function* () {
      const toolkit = yield* AgentSessionsToolkit;
      const scanned = yield* toolkit
        .handle("t3_agent_sessions_scan", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(scanned.at(-1)?.result).toEqual(scan);
      const call = (input: Parameters<typeof toolkit.handle<"t3_agent_sessions_import">>[1]) =>
        toolkit.handle("t3_agent_sessions_import", input).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );
      expect(yield* call({ projectId, expectedWorkspaceRoot: scan.candidates[0]!.path })).toEqual({
        importedCount: 2,
        skippedCount: 1,
      });
      expect(yield* call({ projectId, expectedWorkspaceRoot: "/old/path" })).toMatchObject({
        code: "invalid_request",
        message: new AgentSessionImportProjectChangedError({ projectId }).message,
      });
      const missing = ProjectId.make("missing");
      expect(yield* call({ projectId: missing })).toMatchObject({
        code: "invalid_request",
        message: new AgentSessionImportProjectNotFoundError({ projectId: missing }).message,
      });
    }).pipe(Effect.provide(layerToolkit)),
);

const accessCases = (
  [
    "read-only",
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ] satisfies AuthMcpClientAccess[]
).flatMap((access) => [false, true].map((linked) => ({ access, linked })));

it.effect.each(accessCases)(
  "allows $access clients (linked: $linked) to scan and restricts imports to full access",
  ({ access, linked }) =>
    Effect.gen(function* () {
      const toolkit = yield* AgentSessionsToolkit;
      const clientScope = {
        ...scope,
        thread: undefined,
        client: { sessionId: "client:import", label: "Test client", access, linked },
      };
      const scanned = yield* toolkit
        .handle("t3_agent_sessions_scan", {})
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope),
        );
      expect(scanned.at(-1)?.result).toEqual(scan);
      const imported = yield* toolkit
        .handle("t3_agent_sessions_import", {
          projectId,
          expectedWorkspaceRoot: scan.candidates[0]!.path,
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope),
          Effect.provideService(
            AgentSessionImporter.AgentSessionImporter,
            AgentSessionImporter.AgentSessionImporter.of({
              importRecentAgentThreads: () =>
                access === "full-access"
                  ? Effect.succeed({ importedCount: 1, skippedCount: 0 })
                  : Effect.die("Import must not run for a restricted client"),
              importNativeHistory: () => Effect.die("Native history is not used"),
            }),
          ),
        );
      expect(imported.at(-1)?.result).toMatchObject(
        access === "full-access"
          ? { importedCount: 1, skippedCount: 0 }
          : { code: "capability_denied" },
      );
    }).pipe(Effect.provide(layerToolkit)),
);

it.effect("does not disclose internal scan or import failures", () =>
  Effect.gen(function* () {
    const toolkit = yield* AgentSessionsToolkit;
    const scanned = yield* toolkit.handle("t3_agent_sessions_scan", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(
        AgentSessionScanner.AgentSessionScanner,
        AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.fail(
            new AgentSessionScanError({
              operation: "read-projects",
              cause: "private filesystem details",
            }),
          ),
          recentThreads: () => Stream.empty,
        }),
      ),
    );
    expect(scanned.at(-1)?.result).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
    const imported = yield* toolkit.handle("t3_agent_sessions_import", { projectId }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(
        AgentSessionImporter.AgentSessionImporter,
        AgentSessionImporter.AgentSessionImporter.of({
          importRecentAgentThreads: () =>
            Effect.fail(
              new AgentSessionScanError({
                operation: "read-settings",
                cause: "private settings details",
              }),
            ),
          importNativeHistory: () => Effect.die("Native history is not used"),
        }),
      ),
    );
    expect(imported.at(-1)?.result).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
  }).pipe(Effect.provide(layerToolkit)),
);
