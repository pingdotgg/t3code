import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthStandardClientScopes,
  PluginActionId,
  type PluginActionsSnapshot,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

type ActionMethod =
  | typeof WS_METHODS.pluginActionsSubscribe
  | typeof WS_METHODS.pluginActionsInvoke;
const actionMethods: ReadonlySet<string> = new Set([
  WS_METHODS.pluginActionsSubscribe,
  WS_METHODS.pluginActionsInvoke,
]);

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, ActionMethod> =>
      !actionMethods.has(tag),
  ),
);

const actionId = PluginActionId.make("installation-1:1:say-hello");
const snapshot: PluginActionsSnapshot = {
  actions: [
    {
      id: actionId,
      pluginId: "test.actions",
      pluginName: "Actions fixture",
      name: "say-hello",
      title: "Say hello",
      target: "environment",
      placements: ["command-palette"],
    },
  ],
};
const invoke = { actionId, target: { _tag: "environment" as const } };

/** Serves the action RPCs through the real scope middleware; handlers record that they ran. */
const makeClient = (scopes: ReadonlyArray<AuthEnvironmentScope>, handled: Array<string>) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.pluginActionsSubscribe, () =>
          Stream.fromEffect(
            Effect.sync(() => handled.push(WS_METHODS.pluginActionsSubscribe)).pipe(
              Effect.as(snapshot),
            ),
          ),
        ),
        group.toLayerHandler(WS_METHODS.pluginActionsInvoke, () =>
          Effect.sync(() => handled.push(WS_METHODS.pluginActionsInvoke)).pipe(
            Effect.as({ message: "Hello" }),
          ),
        ),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );

describe("plugin action RPC scopes", () => {
  it.effect("lets a standard pairing list and run the actions an administrator enabled", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(AuthStandardClientScopes, handled);

      expect(
        yield* client[WS_METHODS.pluginActionsSubscribe]({}).pipe(
          Stream.take(1),
          Stream.runCollect,
        ),
      ).toEqual([snapshot]);
      expect(yield* client[WS_METHODS.pluginActionsInvoke](invoke)).toEqual({ message: "Hello" });
      expect(handled).toEqual([WS_METHODS.pluginActionsSubscribe, WS_METHODS.pluginActionsInvoke]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to run an action for a read-only session", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient([AuthOrchestrationReadScope], handled);

      expect(yield* client[WS_METHODS.pluginActionsInvoke](invoke).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "EnvironmentAuthorizationError",
          requiredScope: AuthOrchestrationOperateScope,
        },
      );
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses the list without the orchestration read scope", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient([AuthRelayReadScope], handled);

      expect(
        yield* client[WS_METHODS.pluginActionsSubscribe]({}).pipe(Stream.runCollect, Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
