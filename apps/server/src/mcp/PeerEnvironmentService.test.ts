import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestratorMcpFailure,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type PeerEnvironmentOperation,
  type PeerEnvironmentResult,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as PeerEnvironmentBroker from "./PeerEnvironmentBroker.ts";
import * as PeerEnvironmentService from "./PeerEnvironmentService.ts";

const local = EnvironmentId.make("environment-macbook");
const r2d2 = EnvironmentId.make("environment-r2d2");
const callerThreadId = ThreadId.make("caller-thread");
const codex = ProviderInstanceId.make("codex");
const codexThree = ProviderInstanceId.make("codex_three");
const remoteProject = ProjectId.make("r2d2-project");
const remoteThread = ThreadId.make("r2d2-thread");

const scope: McpInvocationScope = {
  requestNamespace: "test",
  client: undefined,
  environmentId: local,
  thread: {
    threadId: callerThreadId,
    providerSessionId: "session",
    providerInstanceId: codex,
  },
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
};

const caller = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: callerThreadId,
    projectId: ProjectId.make("macbook-project"),
    providerInstanceId: codex,
    modelSelection: { instanceId: codex, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: "active-run",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const catalog: Extract<PeerEnvironmentResult, { operation: "catalog" }> = {
  operation: "catalog",
  label: "r2d2",
  serverVersion: "1.0.0",
  projects: [{ id: remoteProject, title: "t3code", workspaceRoot: "/srv/t3code" }] as never,
  providers: [
    {
      instanceId: codexThree,
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "gpt-5", name: "GPT-5" }],
    } as unknown as ServerProvider,
  ],
};

const projection = (status: string) =>
  ({
    thread: { id: remoteThread, projectId: remoteProject },
    runs: [{ id: "run-1", ordinal: 1, status }],
  }) as unknown as OrchestrationV2ThreadProjection;

/** Runs `use` against a service whose broker answers from `answer` and records what it was asked. */
const withService = <A, E>(
  options: {
    readonly caller?: OrchestrationV2ThreadShell;
    readonly answer?: (operation: PeerEnvironmentOperation) => PeerEnvironmentResult;
  },
  use: (
    service: PeerEnvironmentService.PeerEnvironmentService["Service"],
    asked: ReadonlyArray<PeerEnvironmentOperation>,
  ) => Effect.Effect<A, E>,
) => {
  const asked: Array<PeerEnvironmentOperation> = [];
  const answer = options.answer ?? (() => catalog);
  return Effect.gen(function* () {
    return yield* use(yield* PeerEnvironmentService.PeerEnvironmentService, asked);
  }).pipe(
    Effect.provide(
      PeerEnvironmentService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(options.caller ?? caller()),
            }),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getDescriptor: Effect.succeed({ environmentId: local, label: "MacBook" } as never),
            }),
            Layer.mock(PeerEnvironmentBroker.PeerEnvironmentBroker)({
              list: Effect.fail(
                new PeerEnvironmentBroker.PeerEnvironmentBrokerError({
                  code: "host_unavailable",
                  message: "No app is connected.",
                }),
              ),
              invoke: ((operation: PeerEnvironmentOperation) =>
                Effect.sync(() => {
                  asked.push(operation);
                  return answer(operation);
                })) as never,
            }),
          ),
        ),
      ),
    ),
  );
};

const launch = {
  environmentId: r2d2,
  projectId: remoteProject,
  modelSelection: { instanceId: codexThree, model: "gpt-5" },
  title: "Remote work",
  message: "Do the thing",
};

it.effect.each([
  ["an approval-required caller", caller({ runtimeMode: "approval-required" })],
  ["a plan-mode caller", caller({ interactionMode: "plan" })],
] as const)("refuses a launch on another environment from %s", ([, denied]) =>
  withService({ caller: denied }, (service, asked) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(service.launchThread(scope, launch));
      assert.equal(error.code, "capability_denied");
      assert.deepEqual(asked, []);
    }),
  ),
);

it.effect("refuses a launch once the calling thread no longer owns an active run", () =>
  withService({ caller: caller({ activeRunId: null }) }, (service, asked) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(service.launchThread(scope, launch));
      assert.equal(error.code, "parent_not_active");
      assert.deepEqual(asked, []);
    }),
  ),
);

it.effect("refuses every peer operation for a credential without orchestration", () =>
  withService({}, (service, asked) =>
    Effect.gen(function* () {
      const restricted = { ...scope, capabilities: new Set(["preview" as const]) };
      const attempts: ReadonlyArray<Effect.Effect<object, OrchestratorMcpFailure>> = [
        service.list(restricted),
        service.catalog(restricted, r2d2),
        service.launchThread(restricted, launch),
        service.readThread(restricted, { environmentId: r2d2, threadId: remoteThread }),
        service.waitForThread(restricted, { environmentId: r2d2, threadId: remoteThread }),
      ];
      for (const attempt of attempts) {
        assert.equal((yield* Effect.flip(attempt)).code, "capability_denied");
      }
      assert.deepEqual(asked, []);
    }),
  ),
);

it.effect("requires the target's own project and model instead of inheriting the caller's", () =>
  withService({}, (service, asked) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        service.launchThread(scope, { environmentId: r2d2, title: "Remote work" }),
      );
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "t3_environment_catalog");
      assert.deepEqual(asked, []);
    }),
  ),
);

it.effect("rejects ids that do not exist on the target before creating anything there", () =>
  withService({}, (service, asked) =>
    Effect.gen(function* () {
      const wrongProject = yield* Effect.flip(
        service.launchThread(scope, { ...launch, projectId: ProjectId.make("macbook-project") }),
      );
      assert.equal(wrongProject.code, "invalid_request");
      const wrongProvider = yield* Effect.flip(
        service.launchThread(scope, {
          ...launch,
          modelSelection: { instanceId: codex, model: "gpt-5" },
        }),
      );
      assert.equal(wrongProvider.code, "provider_unavailable");
      assert.include(wrongProvider.message, "codex_three");
      const wrongModel = yield* Effect.flip(
        service.launchThread(scope, {
          ...launch,
          modelSelection: { instanceId: codexThree, model: "not-a-model" },
        }),
      );
      assert.equal(wrongModel.code, "model_unavailable");
      assert.isFalse(asked.some((operation) => operation.operation === "launch"));
    }),
  ),
);

it.effect("launches on the target with the caller's modes and the supplied ids", () =>
  withService(
    {
      answer: (operation) =>
        operation.operation === "launch"
          ? {
              operation: "launch",
              result: {
                threadId: operation.input.threadId ?? remoteThread,
                resumed: false,
                projection: {
                  thread: {
                    id: operation.input.threadId,
                    projectId: operation.input.projectId,
                    modelSelection: operation.input.modelSelection,
                  },
                  runs: [
                    {
                      id: "run-1",
                      status: "preparing",
                      userMessageId: operation.input.initialMessage?.messageId,
                    },
                  ],
                } as never,
              },
            }
          : catalog,
    },
    (service, asked) =>
      Effect.gen(function* () {
        const result = yield* service.launchThread(scope, launch);
        yield* service.launchThread(scope, launch);
        // A batch of launches reads the target's catalog once.
        assert.lengthOf(
          asked.filter((operation) => operation.operation === "catalog"),
          1,
        );
        const sent = asked.find((operation) => operation.operation === "launch");
        assert.equal(sent?.environmentId, r2d2);
        assert.deepInclude(sent?.input, {
          projectId: remoteProject,
          modelSelection: launch.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          creationSource: "mcp",
        });
        assert.equal(result.projectId, remoteProject);
        assert.equal(result.runId, "run-1");
        assert.equal(result.status, "preparing");
      }),
  ),
);

it.effect("lists only this environment, with the reason, when no app can carry requests", () =>
  withService({}, (service) =>
    Effect.gen(function* () {
      const result = yield* service.list(scope);
      assert.deepEqual(result.environments, [
        { environmentId: local, label: "MacBook", local: true, status: "connected" },
      ]);
      assert.equal(result.unavailableReason, "No app is connected.");
    }),
  ),
);

it.effect("waits on a remote run until it settles", () => {
  let reads = 0;
  return withService(
    {
      answer: () => ({
        operation: "thread_projection",
        projection: projection(++reads < 3 ? "running" : "completed"),
      }),
    },
    (service) =>
      Effect.gen(function* () {
        const fiber = yield* service
          .waitForThread(scope, { environmentId: r2d2, threadId: remoteThread })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(10_000);
        assert.deepInclude(yield* Fiber.join(fiber), { status: "completed", timedOut: false });
      }),
  );
});

it.effect("reports the latest status when a remote wait times out", () =>
  withService(
    { answer: () => ({ operation: "thread_projection", projection: projection("running") }) },
    (service) =>
      Effect.gen(function* () {
        const fiber = yield* service
          .waitForThread(scope, { environmentId: r2d2, threadId: remoteThread, timeoutMs: 5_000 })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(6_000);
        assert.deepInclude(yield* Fiber.join(fiber), { status: "running", timedOut: true });
      }),
  ),
);

it.effect("allows a full-access MCP client to launch on a connected environment", () =>
  withService(
    {
      answer: (operation) =>
        operation.operation === "launch"
          ? {
              operation: "launch",
              result: {
                threadId: remoteThread,
                resumed: false,
                projection: {
                  ...projection("queued"),
                  thread: {
                    ...projection("queued").thread,
                    modelSelection: launch.modelSelection!,
                  },
                },
              },
            }
          : catalog,
    },
    (service, asked) =>
      Effect.gen(function* () {
        const clientScope: McpInvocationScope = {
          ...scope,
          thread: undefined,
          client: {
            sessionId: "client-session",
            label: "External agent",
            access: "full-access",
          },
        };
        yield* service.launchThread(clientScope, launch);
        assert.equal(asked.at(-1)?.operation, "launch");
        const denied = yield* service
          .launchThread(
            {
              ...clientScope,
              client: { ...clientScope.client!, access: "approval-required" },
            },
            launch,
          )
          .pipe(Effect.flip);
        assert.equal(denied.code, "capability_denied");
        assert.equal(asked.filter((operation) => operation.operation === "launch").length, 1);
      }),
  ),
);
