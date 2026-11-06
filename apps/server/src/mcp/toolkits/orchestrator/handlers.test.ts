import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  EnvironmentId,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  ProviderInstanceId,
} from "@t3tools/contracts";

import * as OpenShellFleetService from "../../../environment/OpenShellFleetService.ts";
import { OrchestratorToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const threadId = "thread:parent" as never;

interface Harness {
  readonly spawns: Array<
    Parameters<OpenShellFleetService.OpenShellFleetService["Service"]["spawnWorker"]>[0]
  >;
  readonly delegated: Array<OrchestratorMcpDelegateTaskInput>;
  readonly failSpawn?: OpenShellFleetService.OpenShellFleetError;
}

const run = (input: OrchestratorMcpDelegateTaskInput, harness: Harness) =>
  Effect.gen(function* () {
    const caller = {
      scope: undefined as never,
      threads: {} as never,
      caller: {
        id: threadId,
        runtimeMode: "full-access",
        interactionMode: "default",
        archivedAt: null,
        providerInstanceId: ProviderInstanceId.make("pi"),
        activeRunId: "run:parent",
        deletedAt: null,
      },
      limits: { runtimeMode: "full-access" as const, interactionMode: "default" as const },
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId,
          providerInstanceId: ProviderInstanceId.make("pi"),
          providerSessionId: "session",
        },
        client: {
          sessionId: "session",
          label: "Test",
          access: "full-access" as const,
        },
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller.caller as never),
      }),
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        delegateTask: (_scope, params) => {
          harness.delegated.push(params);
          return Effect.succeed({
            taskId: "node:task",
            childThreadId: null,
            remoteChild: {
              environmentId: EnvironmentId.make("environment:worker"),
              threadId: "thread:child",
              label: "worker",
            },
            childRunId: null,
            childNodeId: "node:task",
            status: "running",
            workState: "working",
            hasPendingChildRuns: false,
            latestTerminalRunId: null,
            latestTerminalStatus: null,
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
            providerInstanceId: ProviderInstanceId.make("pi"),
            model: null,
            summary: null,
            resultContextTransferId: null,
            hasPendingQuestion: false,
            pendingApproval: null,
            waitTimedOut: false,
          } as unknown as OrchestratorMcpDelegateTaskResult);
        },
      }),
      Layer.mock(OpenShellFleetService.OpenShellFleetService)({
        spawnWorker: (params) => {
          harness.spawns.push(params);
          return harness.failSpawn === undefined
            ? Effect.succeed({
                environmentId: EnvironmentId.make("environment:worker"),
                sandbox: { name: "worker", id: "sandbox-1" },
                workerClass: params.workerClass,
                state: "ready",
                expiresAt: null,
                warnings: [],
              } as never)
            : Effect.fail(harness.failSpawn);
        },
        removeWorker: () => Effect.die("removeWorker is not part of this path"),
        listWorkers: () => Effect.succeed([]),
      }),
    );
    const toolkit = yield* OrchestratorToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const events = yield* toolkit
      .handle("delegate_task", input)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return events.at(-1)?.result;
  });

describe("delegate_task openshell-auto isolation", () => {
  it.effect("provisions an ephemeral worker and delegates into it", () =>
    Effect.gen(function* () {
      const harness: Harness = { spawns: [], delegated: [] };
      yield* run({ task: "Do the thing", isolation: "openshell-auto" }, harness);

      expect(harness.spawns).toHaveLength(1);
      expect(harness.spawns[0]).toMatchObject({
        workerClass: "ephemeral",
        runtimeModeCeiling: "full-access",
      });
      // The child runs there, not here: the sandbox is the isolation.
      expect(harness.delegated[0]?.isolation).toBe("shared");
      expect(harness.delegated[0]?.target).toMatchObject({
        environmentId: EnvironmentId.make("environment:worker"),
      });
    }),
  );

  it.effect("delegates locally without provisioning anything", () =>
    Effect.gen(function* () {
      const harness: Harness = { spawns: [], delegated: [] };
      yield* run({ task: "Do the thing" }, harness);

      expect(harness.spawns).toHaveLength(0);
      expect(harness.delegated[0]?.target).toBeUndefined();
    }),
  );

  it.effect("reports a refused spawn as a mode-escalation denial", () =>
    Effect.gen(function* () {
      const harness: Harness = {
        spawns: [],
        delegated: [],
        failSpawn: new OpenShellFleetService.OpenShellFleetSpawnRefused({
          reason: "runtime_mode_above_ceiling",
          message:
            "Worker policy full-access is broader than this caller's approval-required ceiling.",
        }),
      };
      const result = (yield* run(
        { task: "Do the thing", isolation: "openshell-auto" },
        harness,
      )) as { readonly code?: string } | undefined;

      expect(harness.delegated).toHaveLength(0);
      expect(result?.code).toBe("runtime_mode_escalation_denied");
    }),
  );
});
