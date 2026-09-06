import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Project,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  type KeyedSerialExecutor,
  makeKeyedSerialExecutor,
} from "../orchestration-v2/KeyedSerialExecutor.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ThreadCommandExecutor } from "../orchestration-v2/ThreadCommandExecutor.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  layer as threadManagementLayer,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as TerminalMcpService from "./TerminalMcpService.ts";

const callerThreadId = ThreadId.make("thread:terminal-policy-caller");
const targetThreadId = ThreadId.make("thread:terminal-policy-target");
const projectId = ProjectId.make("project:terminal-policy");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6",
};

function project(workspaceRoot: string): Project {
  return {
    id: projectId,
    title: "Terminal policy project",
    workspaceRoot,
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    deletedAt: null,
  };
}

it.effect("serializes caller and target policy writers through terminal side effects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const baseDispatch = yield* makeKeyedSerialExecutor<ThreadId>();
      const acquisitionCounts = yield* Ref.make(new Map<ThreadId, number>());
      const callerWriterWaiting = yield* Deferred.make<void>();
      const targetWriterWaiting = yield* Deferred.make<void>();
      const instrumentedDispatch: KeyedSerialExecutor<ThreadId> = {
        withLock: (threadId, effect) =>
          Effect.gen(function* () {
            const count = yield* Ref.modify(acquisitionCounts, (current) => {
              const next = new Map(current);
              const updated = (next.get(threadId) ?? 0) + 1;
              next.set(threadId, updated);
              return [updated, next] as const;
            });
            if (count === 2 && threadId === callerThreadId) {
              yield* Deferred.succeed(callerWriterWaiting, undefined);
            }
            if (count === 2 && threadId === targetThreadId) {
              yield* Deferred.succeed(targetWriterWaiting, undefined);
            }
            return yield* baseDispatch.withLock(threadId, effect);
          }),
      };
      const dispatchLayer = Layer.succeed(ThreadCommandExecutor, instrumentedDispatch);
      const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
        {
          name: "terminal-mcp-policy-race",
          runtimePolicyOverride: {
            cwd: "/tmp/terminal-mcp-policy",
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        },
        makeProviderAdapterRegistryLayer([]),
        { runEffectWorker: false, threadCommandExecutorLayer: dispatchLayer },
      );
      const applicationLayer = Layer.merge(
        orchestratorLayer,
        threadManagementLayer.pipe(Layer.provide(orchestratorLayer)),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const threads = yield* ThreadManagementService;
        const threadDispatch = yield* ThreadCommandExecutor;
        for (const threadId of [callerThreadId, targetThreadId]) {
          yield* threads.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:terminal-policy:create:${threadId}`),
            threadId,
            projectId,
            title: threadId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
        }
        yield* Ref.set(acquisitionCounts, new Map());

        const terminalEntered = yield* Deferred.make<void>();
        const releaseTerminal = yield* Deferred.make<void>();
        const terminalManager = Layer.mock(TerminalManager.TerminalManager)({
          openOrInspect: (input) =>
            Deferred.succeed(terminalEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTerminal)),
              Effect.as({
                created: true,
                snapshot: {
                  threadId: input.threadId,
                  terminalId: input.terminalId,
                  cwd: input.cwd,
                  worktreePath: input.worktreePath ?? null,
                  status: "running" as const,
                  pid: 41_001,
                  history: "",
                  exitCode: null,
                  exitSignal: null,
                  hasRunningSubprocess: false,
                  label: "Shell",
                  updatedAt: "2026-08-29T00:00:00.000Z",
                  sequence: 1,
                },
              }),
            ),
        });
        const projects = Layer.mock(ProjectService.ProjectService)({
          getById: (requestedProjectId) =>
            Effect.succeed(
              requestedProjectId === projectId
                ? Option.some(project("/tmp/terminal-mcp-policy"))
                : Option.none(),
            ),
        });
        const terminalService = yield* TerminalMcpService.make.pipe(
          Effect.provideService(ThreadManagementService, threads),
          Effect.provideService(ThreadCommandExecutor, threadDispatch),
          Effect.provide(Layer.merge(terminalManager, projects)),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:terminal-policy"),
          threadId: callerThreadId,
          providerSessionId: "provider-session:terminal-policy",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        const openFiber = yield* terminalService
          .open(scope, { threadId: targetThreadId, terminalId: "term-policy-race" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(terminalEntered);

        const callerWriter = yield* threads
          .dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("command:terminal-policy:caller-plan"),
            threadId: callerThreadId,
            interactionMode: "plan",
          })
          .pipe(Effect.forkScoped);
        const targetWriter = yield* threads
          .dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("command:terminal-policy:target-approval"),
            threadId: targetThreadId,
            runtimeMode: "approval-required",
          })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(callerWriterWaiting);
        yield* Deferred.await(targetWriterWaiting);
        assert.equal(
          (yield* orchestrator.getThreadProjection(callerThreadId)).thread.interactionMode,
          "default",
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(targetThreadId)).thread.runtimeMode,
          "full-access",
        );

        yield* Deferred.succeed(releaseTerminal, undefined);
        assert.equal((yield* Fiber.join(openFiber)).outcome, "opened");
        yield* Fiber.join(callerWriter);
        yield* Fiber.join(targetWriter);
        assert.equal(
          (yield* orchestrator.getThreadProjection(callerThreadId)).thread.interactionMode,
          "plan",
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(targetThreadId)).thread.runtimeMode,
          "approval-required",
        );
      }).pipe(Effect.provide(applicationLayer));
    }),
  ),
);
