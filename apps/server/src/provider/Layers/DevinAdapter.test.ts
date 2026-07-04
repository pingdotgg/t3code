// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  ApprovalRequestId,
  DevinSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;
const mockDevinEnvironments = new Map<string, NodeJS.ProcessEnv>();

async function makeMockDevinWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-devin");
  mockDevinEnvironments.set(wrapperPath, extraEnv ?? {});
  return wrapperPath;
}

const devinAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeDevinAdapter>[1]) =>
  Effect.gen(function* () {
    const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const extraEnvironment = mockDevinEnvironments.get(binaryPath);
    const environment =
      extraEnvironment || options?.environment
        ? { ...extraEnvironment, ...options?.environment }
        : undefined;
    const adapterOptions = {
      ...options,
      ...(environment ? { environment } : {}),
    } satisfies Parameters<typeof makeDevinAdapter>[1];
    const mockSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
      ...realSpawner,
      spawn: (command) => {
        if (command._tag === "StandardCommand" && command.command === binaryPath) {
          return realSpawner.spawn(
            ChildProcess.make(mockAgentCommand, [mockAgentPath, ...command.args], command.options),
          );
        }
        return realSpawner.spawn(command);
      },
    });

    return yield* makeDevinAdapter(decodeDevinSettings({ binaryPath }), adapterOptions).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mockSpawner),
    );
  }).pipe(Effect.orDie);

it.layer(devinAdapterTestLayer)("DevinAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "composer-2" },
      });

      assert.equal(session.provider, "devin");
      assert.equal(session.model, "composer-2");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello devin",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((event) => event.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reports discovered models from real ACP session startup", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-session-model-discovery");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const discovered = yield* Deferred.make<ReadonlyArray<ServerProviderModel>>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        onSessionModelsDiscovered: (models) =>
          Deferred.succeed(discovered, models).pipe(Effect.asVoid),
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const models = yield* Deferred.await(discovered);
      assert.includeMembers(
        models.map((model) => model.slug),
        ["auto", "composer-2", "codex-5-3"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles ACP session elicitation requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-session-elicitation");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_ELICITATION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask for Devin options", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.raw?.method, "session/elicitation");
      assert.deepEqual(
        requestedEvent.payload.questions.map((question) => ({
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
          required: question.required,
          multiSelect: question.multiSelect,
        })),
        [
          {
            id: "scope",
            question: "Which scope should Devin use?",
            options: ["Workspace", "Session"],
            required: true,
            multiSelect: false,
          },
          {
            id: "fast",
            question: "Use fast mode?",
            options: ["Yes", "No"],
            required: true,
            multiSelect: false,
          },
          {
            id: "notes",
            question: "Any extra notes?",
            options: [],
            required: true,
            multiSelect: false,
          },
        ],
      );

      const invalidError = yield* Effect.flip(
        adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.make(String(requestedEvent.requestId)),
          {
            scope: "Workspace",
            fast: "Yes",
          },
        ),
      );
      assert.equal(invalidError._tag, "ProviderAdapterRequestError");
      if (invalidError._tag === "ProviderAdapterRequestError") {
        assert.equal(
          invalidError.detail,
          "Invalid Devin elicitation response: missing required answers.",
        );
      }

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          scope: "Workspace",
          fast: "Yes",
          notes: "Keep it focused",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        scope: "Workspace",
        fast: "Yes",
        notes: "Keep it focused",
      });
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId));
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("accepts URL elicitation completion notifications", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-url-elicitation-complete");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_URL_ELICITATION_COMPLETE: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "complete URL elicitation",
        attachments: [],
      });

      assert.isDefined(turn.turnId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("preserves an existing session when a restart fails after ACP start", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-preserve-session-on-restart-failure");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_FAIL_MODEL_CONFIG_OPTION: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const firstSession = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const restartError = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("devin"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "composer-2" },
        }),
      );
      const sessions = yield* adapter.listSessions();
      const preserved = sessions.find((session) => String(session.threadId) === String(threadId));

      assert.equal(restartError._tag, "ProviderAdapterRequestError");
      assert.deepEqual(preserved?.resumeCursor, firstSession.resumeCursor);
      assert.equal(preserved?.status, "ready");

      yield* adapter.stopSession(threadId);
    }),
  );
});
