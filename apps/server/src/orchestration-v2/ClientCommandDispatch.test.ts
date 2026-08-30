import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ClientCommandDispatch from "./ClientCommandDispatch.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

it.effect("routes WebSocket thread creation through receipt-aware project admission", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:client-command-admission");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const project = {
      id: projectId,
      title: "Client command admission",
      workspaceRoot: "/work/client-command-admission",
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      scripts: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      deletedAt: null,
    } satisfies Project;
    const projectState = yield* Ref.make<Project | null>(project);
    const adapter = {
      instanceId: providerInstanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("provider execution is disabled in client command tests"),
    } as ProviderAdapterV2Shape;
    const registry = ProviderAdapterRegistry.makeLayer([adapter]);
    const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
      { name: "client-command-admission" },
      registry,
      { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
    );
    const threadsLayer = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
    const projectsLayer = Layer.mock(ProjectService.ProjectService)({
      getById: () => Ref.get(projectState).pipe(Effect.map(Option.fromNullishOr)),
    });

    yield* Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const dispatchClientCommand = (yield* ClientCommandDispatch.make).dispatch;
      const command = {
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:client-command-admission:create"),
        threadId: ThreadId.make("thread:client-command-admission:create"),
        projectId,
        title: "Created from WebSocket",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      } as const;

      yield* dispatchClientCommand(command);
      const sequenceBeforeReplay = yield* threads.getThreadEventSequence(command.threadId);
      yield* Ref.set(projectState, null);

      yield* dispatchClientCommand(command);
      expect(yield* threads.getThreadEventSequence(command.threadId)).toBe(sequenceBeforeReplay);

      const freshCommand = {
        ...command,
        commandId: CommandId.make("command:client-command-admission:fresh"),
        threadId: ThreadId.make("thread:client-command-admission:fresh"),
      };
      const rejected = yield* dispatchClientCommand(freshCommand).pipe(Effect.flip);
      expect(rejected).toMatchObject({ _tag: "ProjectMutationError" });
      expect(
        Option.isNone(yield* Effect.option(threads.getThreadProjection(freshCommand.threadId))),
      ).toBe(true);
    }).pipe(Effect.provide(Layer.mergeAll(threadsLayer, projectsLayer)));
  }),
);
