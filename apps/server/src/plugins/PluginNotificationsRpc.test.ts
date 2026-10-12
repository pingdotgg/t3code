import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthStandardClientScopes,
  type PluginNotificationFrame,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as PluginNotifications from "./PluginNotifications.ts";
import { PluginSupervisor } from "./PluginSupervisor.ts";
import { recordingSupervisor, registrationFor } from "./testFixtures/hostCalls.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const TAG = WS_METHODS.pluginsNotificationsSubscribe;

// The server group narrowed to this RPC; it keeps the group's scope middleware.
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof TAG> => tag !== TAG,
  ),
);

/** The real notification service behind the scope middleware, as ws.ts serves it. */
const serve = Effect.fn("serve")(function* (scopes: ReadonlyArray<AuthEnvironmentScope>) {
  const { supervisor, call } = recordingSupervisor();
  const notifications = yield* PluginNotifications.make().pipe(
    Effect.provideService(PluginSupervisor, supervisor),
  );
  let subscriptions = 0;
  const client = yield* RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.merge(
        group.toLayerHandler(TAG, () =>
          Stream.unwrap(Effect.sync(() => (subscriptions++, notifications.subscribe))),
        ),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );
  const show = (pluginId: string, lifetime: Scope.Scope, title: string) =>
    call("notifications.show", registrationFor(pluginId), lifetime, { title });
  /** Subscribes as a client does on (re)connect; `next` waits for its next frame. */
  const connect = Effect.fn("connect")(function* (connection: Scope.Scope) {
    const pull = yield* Stream.toPull(client[TAG]({})).pipe(Scope.provide(connection));
    const buffered: Array<PluginNotificationFrame> = [];
    return Effect.gen(function* () {
      while (buffered.length === 0) buffered.push(...(yield* pull));
      return buffered.shift()!.notifications.map((notification) => notification.title);
    });
  });
  return { client, show, connect, subscriptions: () => subscriptions };
});

it.layer(NodeServices.layer)("plugins.notifications.subscribe", (it) => {
  it.effect("gives a reconnecting client the retained set, without what was withdrawn", () =>
    Effect.gen(function* () {
      const { show, connect } = yield* serve(AuthStandardClientScopes);
      const lifetime = yield* Scope.make();
      const stopped = yield* Scope.make();

      const first = yield* Scope.make();
      const next = yield* connect(first);
      assert.deepStrictEqual(yield* next, []);
      yield* show("acme.a", lifetime, "before");
      assert.deepStrictEqual(yield* next, ["before"]);

      // Offline: the connection's subscription ends while the plugins keep going.
      yield* Scope.close(first, Exit.void);
      yield* show("acme.b", lifetime, "while away");
      yield* show("acme.c", stopped, "withdrawn while away");
      yield* Scope.close(stopped, Exit.void);

      // The reconnect's first frame is the whole retained set; the client
      // toasts only what is above its mark and closes what left the set.
      const again = yield* connect(yield* Scope.make());
      assert.deepStrictEqual(yield* again, ["before", "while away"]);
      yield* show("acme.d", lifetime, "after");
      assert.deepStrictEqual(yield* again, ["before", "while away", "after"]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a client without the orchestration read scope", () =>
    Effect.gen(function* () {
      const { client, subscriptions } = yield* serve([AuthRelayReadScope]);
      const error = yield* client[TAG]({}).pipe(Stream.take(1), Stream.runCollect, Effect.flip);
      assert.deepInclude(error, {
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
      });
      assert.strictEqual(subscriptions(), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a read-only session follow notifications", () =>
    Effect.gen(function* () {
      const { connect, subscriptions } = yield* serve([AuthOrchestrationReadScope]);
      const next = yield* connect(yield* Scope.make());
      assert.deepStrictEqual(yield* next, []);
      assert.strictEqual(subscriptions(), 1);
    }).pipe(Effect.scoped),
  );
});
