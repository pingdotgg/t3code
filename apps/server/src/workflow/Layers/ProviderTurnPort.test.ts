import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ThreadId,
} from "@t3tools/contracts";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../../persistence/Services/ProjectionTurns.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ProviderTurnPort, type DispatchRequest } from "../Services/ProviderDispatchOutbox.ts";
import { ProviderTurnPortLive } from "./ProviderDispatchOutbox.ts";

const baseRequest = {
  dispatchId: "dispatch-1" as never,
  ticketId: "ticket-1" as never,
  stepRunId: "step-run-1" as never,
  threadId: "thread-1" as never,
  providerInstance: "claudeAgent",
  model: "claude-opus-4-6",
  instruction: "Do the workflow step",
  worktreePath: "/tmp/workflow-ticket-1",
} satisfies DispatchRequest;

interface Captured {
  readonly start: Ref.Ref<ProviderSessionStartInput | null>;
  readonly send: Ref.Ref<ProviderSendTurnInput | null>;
  readonly commands?: Array<Record<string, unknown>>;
}

const makeLayer = (captured: Captured) =>
  ProviderTurnPortLive.pipe(
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        dispatch: (command: Record<string, unknown>) =>
          Effect.sync(() => {
            captured.commands?.push(command);
            return { sequence: 1 };
          }),
      } as unknown as OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderService, {
        startSession: (_threadId: ThreadId, input: ProviderSessionStartInput) =>
          Ref.set(captured.start, input).pipe(
            Effect.as({
              provider: "claudeAgent",
              status: "ready",
              runtimeMode: "full-access",
              threadId: input.threadId,
              createdAt: "2026-06-09T00:00:00.000Z",
              updatedAt: "2026-06-09T00:00:00.000Z",
            }),
          ),
        sendTurn: (input: ProviderSendTurnInput) =>
          Ref.set(captured.send, input).pipe(
            Effect.as({ threadId: input.threadId, turnId: "turn-1" }),
          ),
      } as unknown as ProviderServiceShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionTurnRepository, {
        listByThreadId: () => Effect.succeed([]),
      } as unknown as ProjectionTurnRepositoryShape),
    ),
  );

it.effect("forwards agent option selections into the provider model selection", () =>
  Effect.gen(function* () {
    const captured: Captured = {
      start: yield* Ref.make<ProviderSessionStartInput | null>(null),
      send: yield* Ref.make<ProviderSendTurnInput | null>(null),
    };
    const options = [
      { id: "effort", value: "high" },
      { id: "thinking", value: true },
    ] as const;

    yield* Effect.gen(function* () {
      const port = yield* ProviderTurnPort;
      yield* port.ensureTurnStarted({ ...baseRequest, options });
    }).pipe(Effect.provide(makeLayer(captured)));

    const send = yield* Ref.get(captured.send);
    const start = yield* Ref.get(captured.start);
    assert.deepEqual(send?.modelSelection?.options, options);
    assert.deepEqual(start?.modelSelection?.options, options);
  }),
);

it.effect("creates a hidden orchestration thread so ingestion projects the dispatch turn", () =>
  Effect.gen(function* () {
    const commands: Array<Record<string, unknown>> = [];
    const captured: Captured = {
      start: yield* Ref.make<ProviderSessionStartInput | null>(null),
      send: yield* Ref.make<ProviderSendTurnInput | null>(null),
      commands,
    };

    yield* Effect.gen(function* () {
      const port = yield* ProviderTurnPort;
      yield* port.ensureTurnStarted({
        ...baseRequest,
        projectId: "project-1",
        threadTitle: "Workflow step review · ticket-1",
        runtimeMode: "approval-required",
      });
    }).pipe(Effect.provide(makeLayer(captured)));

    assert.equal(commands.length, 1);
    const command = commands[0];
    assert.equal(command?.["type"], "thread.create");
    assert.equal(command?.["threadId"], "thread-1");
    assert.equal(command?.["projectId"], "project-1");
    assert.equal(command?.["title"], "Workflow step review · ticket-1");
    assert.equal(command?.["hidden"], true);
    assert.equal(command?.["runtimeMode"], "approval-required");
    const start = yield* Ref.get(captured.start);
    assert.equal(start?.runtimeMode, "approval-required");
  }),
);

it.effect("skips thread creation when no project id is provided", () =>
  Effect.gen(function* () {
    const commands: Array<Record<string, unknown>> = [];
    const captured: Captured = {
      start: yield* Ref.make<ProviderSessionStartInput | null>(null),
      send: yield* Ref.make<ProviderSendTurnInput | null>(null),
      commands,
    };

    yield* Effect.gen(function* () {
      const port = yield* ProviderTurnPort;
      yield* port.ensureTurnStarted(baseRequest);
    }).pipe(Effect.provide(makeLayer(captured)));

    assert.equal(commands.length, 0);
    const start = yield* Ref.get(captured.start);
    assert.equal(start?.runtimeMode, "full-access");
  }),
);

it.effect("omits model selection options when the agent step has none", () =>
  Effect.gen(function* () {
    const captured: Captured = {
      start: yield* Ref.make<ProviderSessionStartInput | null>(null),
      send: yield* Ref.make<ProviderSendTurnInput | null>(null),
    };

    yield* Effect.gen(function* () {
      const port = yield* ProviderTurnPort;
      yield* port.ensureTurnStarted(baseRequest);
    }).pipe(Effect.provide(makeLayer(captured)));

    const send = yield* Ref.get(captured.send);
    assert.equal(send?.modelSelection?.options, undefined);
  }),
);
