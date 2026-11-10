import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Rpc, RpcClient, RpcGroup, RpcMessage } from "effect/rpc";
import { gatewayEventFromV2 } from "./runtimePort.ts";
import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { subscribe } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";

it.effect("a paused gateway consumer does not block delivery of a replay frame", () =>
  Effect.gen(function* () {
    const method = ORCHESTRATION_V2_WS_METHODS.subscribeShell;
    const group = RpcGroup.make(
      Rpc.make(method, {
        payload: { afterSequence: Schema.Int },
        success: OrchestrationV2ShellStreamItem,
        stream: true,
      }),
    );
    const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof group>>>();
    const { client, write } = yield* RpcClient.makeNoSerialization(group, {
      onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
    });
    const supervisor = {
      target: { environmentId: EnvironmentId.make("test") },
      session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
    } as unknown as EnvironmentSupervisor["Service"];
    const values = Array.from({ length: 500 }, (_, i) => ({
      kind: "thread.updated" as const,
      sequence: i + 1,
      thread: v2ThreadShell,
    })) as [OrchestrationV2ShellStreamItem, ...OrchestrationV2ShellStreamItem[]];
    const entered = yield* Deferred.make<number>();
    const resume = yield* Deferred.make<void>();
    const consumer = yield* subscribe(method, { afterSequence: 0 }, { streamBufferSize: 500 }).pipe(
      Stream.map((item) => gatewayEventFromV2(EnvironmentId.make("test"), item)),
      Stream.filter((event) => event !== undefined),
      Stream.mapArrayEffect((batch) =>
        Deferred.succeed(entered, batch.length).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.as(batch),
        ),
      ),
      Stream.take(500),
      Stream.runCollect,
      Effect.provideService(EnvironmentSupervisor, supervisor),
      Effect.forkScoped,
    );
    const request = yield* Queue.take(requests);
    if (request._tag !== "Request") throw new Error("Expected stream request");
    const delivery = yield* write({
      _tag: "Chunk",
      clientId: 0,
      requestId: request.id,
      values,
    }).pipe(Effect.forkScoped);
    const batchSize = yield* Deferred.await(entered);
    yield* TestClock.adjust(0);
    // The serialized socket reader can now process unrelated RPC replies and Pongs,
    // even if Chromium delays the downstream merge's next scheduled task.
    expect(delivery.pollUnsafe()).toBeDefined();
    expect(batchSize).toBe(500);
    yield* Deferred.succeed(resume, undefined);
    const events = yield* Fiber.join(consumer);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 500 }, (_, i) => i + 1),
    );
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);
