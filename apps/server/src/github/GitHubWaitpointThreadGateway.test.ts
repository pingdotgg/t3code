import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitHubWaitpointThreadGateway, threadGatewayLayer } from "./GitHubWaitpointWorker.ts";

it.effect("dispatches a deterministic continuation command for a ready thread", () =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const thread = {
      id: ThreadId.make("thread-1"),
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      latestTurn: { turnId: "turn-1", state: "completed" },
      session: { status: "ready", activeTurnId: null },
    };
    const snapshots = Layer.succeed(ProjectionSnapshotQuery, {
      getThreadDetailById: () => Effect.succeed(Option.some(thread)),
    } as unknown as ProjectionSnapshotQuery["Service"]);
    const orchestration = Layer.succeed(
      OrchestrationEngineService,
      OrchestrationEngineService.of({
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(commands, (current) => [...current, command]).pipe(Effect.as({ sequence: 1 })),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
    );
    const live = threadGatewayLayer.pipe(Layer.provide(Layer.merge(snapshots, orchestration)));

    yield* Effect.gen(function* () {
      const gateway = yield* GitHubWaitpointThreadGateway;
      const input = {
        waitpointId: "github:thread-1:call-1",
        threadId: ThreadId.make("thread-1"),
        prompt: "GitHub checks settled. Continue.",
        createdAt: "2026-07-22T12:00:00.000Z",
        expectedLatestTurnId: "turn-1",
      };
      yield* gateway.resume(input);
      yield* gateway.resume(input);
      const staleError = yield* gateway
        .resume({ ...input, expectedLatestTurnId: "turn-older" })
        .pipe(Effect.flip);
      assert.equal(staleError._tag, "GitHubWaitpointThreadUnavailableError");
    }).pipe(Effect.provide(live));

    const dispatched = yield* Ref.get(commands);
    assert.lengthOf(dispatched, 2);
    assert.deepInclude(dispatched[0], {
      type: "thread.turn.start",
      commandId: "github-waitpoint:github:thread-1:call-1",
      threadId: "thread-1",
      message: {
        messageId: "github-waitpoint:github:thread-1:call-1",
        role: "user",
        text: "GitHub checks settled. Continue.",
        attachments: [],
      },
    });
    assert.deepEqual(dispatched[0], dispatched[1]);
  }),
);
