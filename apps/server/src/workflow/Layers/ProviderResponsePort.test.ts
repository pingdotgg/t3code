import { assert, it } from "@effect/vitest";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderResponsePort } from "../Services/ProviderResponsePort.ts";
import { ProviderResponsePortLive } from "./ProviderResponsePort.ts";

it.effect("ProviderResponsePortLive keys user-input answers by the awaiting question id", () =>
  Effect.gen(function* () {
    const userInputResponses = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const providerLayer = Layer.succeed(ProviderService, {
      startSession: () => Effect.die("unused"),
      sendTurn: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRequest: () => Effect.die("unused"),
      respondToUserInput: (input) => Ref.update(userInputResponses, (calls) => [...calls, input]),
      stopSession: () => Effect.die("unused"),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.die("unused"),
      getInstanceInfo: () => Effect.die("unused"),
      rollbackConversation: () => Effect.die("unused"),
      streamEvents: Stream.empty,
    });

    const program = Effect.gen(function* () {
      const port = yield* ProviderResponsePort;
      yield* port.respond({
        threadId: ThreadId.make("thread-ticket-answer"),
        requestId: ApprovalRequestId.make("request-ticket-answer"),
        responseKind: "user-input",
        approved: true,
        questionId: "Which API should I use?",
        text: "Use the sandbox endpoint.",
      } as never);
    });

    yield* program.pipe(
      Effect.provide(ProviderResponsePortLive.pipe(Layer.provide(providerLayer))),
    );

    assert.deepEqual(yield* Ref.get(userInputResponses), [
      {
        threadId: "thread-ticket-answer",
        requestId: "request-ticket-answer",
        answers: {
          "Which API should I use?": "Use the sandbox endpoint.",
        },
      },
    ]);
  }),
);

it.effect("ProviderResponsePortLive rejects text user-input answers without a question id", () =>
  Effect.gen(function* () {
    const userInputResponses = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const providerLayer = Layer.succeed(ProviderService, {
      startSession: () => Effect.die("unused"),
      sendTurn: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRequest: () => Effect.die("unused"),
      respondToUserInput: (input) => Ref.update(userInputResponses, (calls) => [...calls, input]),
      stopSession: () => Effect.die("unused"),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.die("unused"),
      getInstanceInfo: () => Effect.die("unused"),
      rollbackConversation: () => Effect.die("unused"),
      streamEvents: Stream.empty,
    });

    const program = Effect.gen(function* () {
      const port = yield* ProviderResponsePort;
      const error = yield* Effect.flip(
        port.respond({
          threadId: ThreadId.make("thread-ticket-answer-missing-question"),
          requestId: ApprovalRequestId.make("request-ticket-answer-missing-question"),
          responseKind: "user-input",
          approved: true,
          text: "Use the sandbox endpoint.",
        } as never),
      );
      assert.include(error.message, "question id");
    });

    yield* program.pipe(
      Effect.provide(ProviderResponsePortLive.pipe(Layer.provide(providerLayer))),
    );

    assert.deepEqual(yield* Ref.get(userInputResponses), []);
  }),
);
