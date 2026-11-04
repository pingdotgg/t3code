import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthStandardClientScopes,
  PluginInstallationId,
  type PluginViewBundle,
  type PluginViewsSnapshot,
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

type ViewMethod =
  | typeof WS_METHODS.pluginViewsSubscribe
  | typeof WS_METHODS.pluginViewsReadBundle
  | typeof WS_METHODS.pluginViewsCall;
const viewMethods: ReadonlySet<string> = new Set([
  WS_METHODS.pluginViewsSubscribe,
  WS_METHODS.pluginViewsReadBundle,
  WS_METHODS.pluginViewsCall,
]);

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, ViewMethod> => !viewMethods.has(tag),
  ),
);

const installationId = PluginInstallationId.make("installation-1");
const target = { installationId, generation: 1, viewId: "board" };
const snapshot: PluginViewsSnapshot = {
  views: [
    {
      ...target,
      pluginId: "test.views-board",
      pluginName: "Board",
      title: "Board",
      placement: "side-panel",
    },
  ],
  problems: [],
};
const bundle: PluginViewBundle = {
  ...target,
  sourceDigest: "digest",
  script: { text: "t3View.ready;", sha256: "hash" },
  style: null,
};
const call = { ...target, handler: "echo", input: { n: 1 } };

/** Serves the view RPCs through the real scope middleware; handlers record that they ran. */
const makeClient = (scopes: ReadonlyArray<AuthEnvironmentScope>, handled: Array<string>) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.pluginViewsSubscribe, () =>
          Stream.fromEffect(
            Effect.sync(() => handled.push(WS_METHODS.pluginViewsSubscribe)).pipe(
              Effect.as(snapshot),
            ),
          ),
        ),
        group.toLayerHandler(WS_METHODS.pluginViewsReadBundle, () =>
          Effect.sync(() => handled.push(WS_METHODS.pluginViewsReadBundle)).pipe(Effect.as(bundle)),
        ),
        group.toLayerHandler(WS_METHODS.pluginViewsCall, () =>
          Effect.sync(() => handled.push(WS_METHODS.pluginViewsCall)).pipe(
            Effect.as({ value: { echo: { n: 1 } } }),
          ),
        ),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );

describe("plugin view RPC scopes", () => {
  it.effect("lets a standard pairing list, load and call into the views of enabled plugins", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(AuthStandardClientScopes, handled);

      expect(
        yield* client[WS_METHODS.pluginViewsSubscribe]({}).pipe(Stream.take(1), Stream.runCollect),
      ).toEqual([snapshot]);
      expect(yield* client[WS_METHODS.pluginViewsReadBundle](target)).toEqual(bundle);
      expect(yield* client[WS_METHODS.pluginViewsCall](call)).toEqual({
        value: { echo: { n: 1 } },
      });
      expect(handled).toEqual([
        WS_METHODS.pluginViewsSubscribe,
        WS_METHODS.pluginViewsReadBundle,
        WS_METHODS.pluginViewsCall,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a read-only session show a view but not run its plugin code", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient([AuthOrchestrationReadScope], handled);

      expect(yield* client[WS_METHODS.pluginViewsReadBundle](target)).toEqual(bundle);
      expect(yield* client[WS_METHODS.pluginViewsCall](call).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationOperateScope,
      });
      expect(handled).toEqual([WS_METHODS.pluginViewsReadBundle]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses the list and the bytes without the orchestration read scope", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient([AuthRelayReadScope], handled);

      expect(
        yield* client[WS_METHODS.pluginViewsSubscribe]({}).pipe(Stream.runCollect, Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
      });
      expect(
        yield* client[WS_METHODS.pluginViewsReadBundle](target).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
