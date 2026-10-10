import {
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthStandardClientScopes,
  PluginInstallationId,
  type PluginSettingsValues,
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

type SettingsMethod =
  | typeof WS_METHODS.pluginsSettingsSubscribe
  | typeof WS_METHODS.pluginsSettingsUpdate;
const settingsMethods: ReadonlySet<string> = new Set([
  WS_METHODS.pluginsSettingsSubscribe,
  WS_METHODS.pluginsSettingsUpdate,
]);

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, SettingsMethod> =>
      !settingsMethods.has(tag),
  ),
);

const installationId = PluginInstallationId.make("fixture");
const values: PluginSettingsValues = { installationId, values: [], secrets: ["token"] };

/** Serves the settings RPCs through the real scope middleware; handlers record that they ran. */
const makeClient = (scopes: ReadonlyArray<AuthEnvironmentScope>, handled: Array<string>) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.pluginsSettingsSubscribe, () =>
          Stream.fromEffect(
            Effect.sync(() => handled.push(WS_METHODS.pluginsSettingsSubscribe)).pipe(
              Effect.as(values),
            ),
          ),
        ),
        group.toLayerHandler(WS_METHODS.pluginsSettingsUpdate, () =>
          Effect.sync(() => handled.push(WS_METHODS.pluginsSettingsUpdate)).pipe(Effect.as(values)),
        ),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );

const update = { installationId, changes: [{ key: "token", value: "fixture-secret" }] };

describe("plugin settings RPC scopes", () => {
  it.effect("lets a standard pairing read values but not save them", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(AuthStandardClientScopes, handled);

      expect(
        yield* client[WS_METHODS.pluginsSettingsSubscribe]({ installationId }).pipe(
          Stream.take(1),
          Stream.runCollect,
        ),
      ).toEqual([values]);
      expect(
        yield* client[WS_METHODS.pluginsSettingsUpdate](update).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthAccessWriteScope,
        requiredPermission: AuthAccessWriteScope,
      });
      expect(handled).toEqual([WS_METHODS.pluginsSettingsSubscribe]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets an administrative pairing save values", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(AuthAdministrativeScopes, handled);

      expect(yield* client[WS_METHODS.pluginsSettingsUpdate](update)).toEqual(values);
      expect(handled).toEqual([WS_METHODS.pluginsSettingsUpdate]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses value reads without the orchestration read scope", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient([AuthRelayReadScope], handled);

      expect(
        yield* client[WS_METHODS.pluginsSettingsSubscribe]({ installationId }).pipe(
          Stream.runCollect,
          Effect.flip,
        ),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
