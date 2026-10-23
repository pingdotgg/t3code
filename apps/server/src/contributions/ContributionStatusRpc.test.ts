import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  type AuthEnvironmentScope,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderOrchestrationAdapterInfrastructure from "../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import * as ContributionStatusStore from "@t3tools/provider-core/server/ContributionStatusStore";

const TAG = WS_METHODS.subscribeContributionStatus;
const THREAD = ThreadId.make("thread-1");
const SOURCE = {
  kind: "provider-session",
  providerSessionId: ProviderSessionId.make("session-1"),
  providerInstanceId: ProviderInstanceId.make("pi"),
  driver: ProviderDriverKind.make("pi"),
} as const;
const encodedEntry = (texts: ReadonlyArray<string>) => ({
  threadId: THREAD,
  source: SOURCE,
  items: texts.map((text, index) => ({ key: `k${index}`, text })),
});

// The server group narrowed to this RPC; it keeps the group's scope middleware.
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof TAG> => tag !== TAG,
  ),
);

/**
 * Serves `subscribeContributionStatus` as ws.ts does (the store's subscription
 * stream behind the connection's scope middleware) over an in-memory RPC protocol.
 */
const serveStatus = Effect.fn("serveStatus")(function* (
  store: ContributionStatusStore.ContributionStatusStoreShape,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) {
  const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
  const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
  const protocol = yield* RpcServer.Protocol.make((write) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(receive, write);
      const serialization = yield* RpcSerialization.RpcSerialization;
      return {
        disconnects: yield* Queue.unbounded<number>(),
        send: (_clientId, response) => Queue.offer(responses, response),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeedNone,
        supportsAck: false,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: true,
        codecFor: serialization.codecFor,
      };
    }),
  );
  yield* RpcServer.make(group).pipe(
    Effect.provide(
      Layer.merge(
        group.toLayerHandler(TAG, () => ContributionStatusStore.subscriptionStream(store)),
        RpcAuthorization.layer(scopes),
      ),
    ),
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.forkScoped,
  );
  const write = yield* Deferred.await(receive);
  return {
    subscribe: (id: string) =>
      write(0, { _tag: "Request", id, tag: TAG, payload: {}, headers: [] }),
    interrupt: (id: string) => write(0, { _tag: "Interrupt", requestId: id }),
    /** The next frame the client receives; the store publishes one per visible change. */
    next: Queue.take(responses),
    /** Lets server fibers run so a frame that would be sent is in the queue. */
    pending: TestClock.adjust(0).pipe(Effect.andThen(Queue.size(responses))),
  };
});

const chunk = (
  requestId: string,
  entries: ReadonlyArray<ReturnType<typeof encodedEntry>>,
): RpcMessage.FromServerEncoded => ({ _tag: "Chunk", requestId, values: [{ entries }] });

describe("subscribeContributionStatus", () => {
  it.effect("streams the current snapshot, replacements, and a fresh snapshot on resubscribe", () =>
    Effect.gen(function* () {
      const store = yield* ContributionStatusStore.make();
      const handle = yield* store.openSource(SOURCE);
      yield* handle.bindThread(THREAD);
      yield* handle.set({ key: "k0", text: "plan" });
      const client = yield* serveStatus(store, [AuthOrchestrationReadScope]);

      yield* client.subscribe("1");
      assert.deepStrictEqual(yield* client.next, chunk("1", [encodedEntry(["plan"])]));

      yield* handle.set({ key: "k0", text: "build" });
      assert.deepStrictEqual(yield* client.next, chunk("1", [encodedEntry(["build"])]));
      yield* handle.clear("k0");
      assert.deepStrictEqual(yield* client.next, chunk("1", []));

      // A reconnect is a new subscription whose first frame is the current state.
      yield* handle.set({ key: "k0", text: "review" });
      assert.deepStrictEqual(yield* client.next, chunk("1", [encodedEntry(["review"])]));
      yield* client.subscribe("2");
      assert.deepStrictEqual(yield* client.next, chunk("2", [encodedEntry(["review"])]));

      // An interrupted subscription stops receiving frames; the other keeps going.
      yield* client.interrupt("1");
      assert.strictEqual((yield* client.next)._tag, "Exit");
      yield* handle.set({ key: "k0", text: "done" });
      assert.deepStrictEqual(yield* client.next, chunk("2", [encodedEntry(["done"])]));
      assert.strictEqual(yield* client.pending, 0);
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );

  it.effect("refuses a client without the orchestration read scope", () =>
    Effect.gen(function* () {
      const store = yield* ContributionStatusStore.make();
      const handle = yield* store.openSource(SOURCE);
      yield* handle.bindThread(THREAD);
      yield* handle.set({ key: "k0", text: "plan" });
      const client = yield* serveStatus(store, [AuthRelayReadScope]);

      yield* client.subscribe("1");
      assert.deepStrictEqual(yield* client.next, {
        _tag: "Exit",
        requestId: "1",
        exit: {
          _tag: "Failure",
          cause: [
            {
              _tag: "Fail",
              error: {
                _tag: "EnvironmentAuthorizationError",
                message: `The authenticated token is missing required scope: ${AuthOrchestrationReadScope}.`,
                requiredPermission: AuthOrchestrationReadScope,
                requiredScope: AuthOrchestrationReadScope,
              },
            },
          ],
        },
      });
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );

  it.effect("shares one store between provider adapters and the WebSocket stream", () =>
    Effect.gen(function* () {
      // Mirrors server.ts: adapters get the store through the provider
      // infrastructure inside an unwrapped instance-registry layer, while the
      // WebSocket layer reads it from the runtime's own reference.
      const producer = Layer.unwrap(
        Effect.succeed(
          Layer.effectDiscard(
            Effect.gen(function* () {
              const store = yield* ContributionStatusStore.ContributionStatusStore;
              const handle = yield* store.openSource(SOURCE);
              yield* handle.bindThread(THREAD);
              yield* handle.set({ key: "k0", text: "from adapter" });
            }),
          ).pipe(Layer.provide(ProviderOrchestrationAdapterInfrastructure.layer)),
        ),
      );
      // As in server.ts, the registry layer sits below the store reference, so
      // the producer only sees the store its own infrastructure provides.
      const runtime = ContributionStatusStore.layer.pipe(
        Layer.provideMerge(producer),
        Layer.provide(
          Layer.merge(
            NodeServices.layer,
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        ),
      );

      const snapshot = yield* Effect.gen(function* () {
        const store = yield* ContributionStatusStore.ContributionStatusStore;
        return yield* store.snapshot;
      }).pipe(Effect.provide(runtime));
      assert.deepStrictEqual(snapshot.entries, [
        { threadId: THREAD, source: SOURCE, items: [{ key: "k0", text: "from adapter" }] },
      ]);
    }),
  );
});
