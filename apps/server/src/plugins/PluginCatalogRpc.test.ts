import {
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthStandardClientScopes,
  PluginCatalogError,
  PluginInstallationId,
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

const reads = [WS_METHODS.pluginsList, WS_METHODS.pluginsSubscribe] as const;
const writes = [
  WS_METHODS.pluginsAdd,
  WS_METHODS.pluginsRefresh,
  WS_METHODS.pluginsConsent,
  WS_METHODS.pluginsEnable,
  WS_METHODS.pluginsDisable,
  WS_METHODS.pluginsRemove,
  WS_METHODS.pluginsResume,
] as const;
type PluginMethod = (typeof reads)[number] | (typeof writes)[number];
const pluginMethods: ReadonlySet<string> = new Set([...reads, ...writes]);

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, PluginMethod> =>
      !pluginMethods.has(tag),
  ),
);

const installationId = PluginInstallationId.make("fixture");
const digest = `sha256:${"0".repeat(64)}`;

/** Serves the plugin RPCs through the real scope middleware; handlers record that they ran. */
const makeClient = (scopes: ReadonlyArray<AuthEnvironmentScope>, handled: Array<string>) => {
  // Mutations answer with a catalogue error: reaching it proves the middleware let the call in.
  const mutation = (method: string) => () =>
    Effect.sync(() => handled.push(method)).pipe(
      Effect.andThen(
        Effect.fail(new PluginCatalogError({ reason: "not-found", message: "fixture" })),
      ),
    );
  return RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.pluginsList, () =>
          Effect.sync(() => handled.push(WS_METHODS.pluginsList)).pipe(
            Effect.as({ installations: [] }),
          ),
        ),
        group.toLayerHandler(WS_METHODS.pluginsSubscribe, () =>
          Stream.fromEffect(
            Effect.sync(() => handled.push(WS_METHODS.pluginsSubscribe)).pipe(
              Effect.as({ installations: [] }),
            ),
          ),
        ),
        group.toLayerHandler(WS_METHODS.pluginsAdd, mutation(WS_METHODS.pluginsAdd)),
        group.toLayerHandler(WS_METHODS.pluginsRefresh, mutation(WS_METHODS.pluginsRefresh)),
        group.toLayerHandler(WS_METHODS.pluginsConsent, mutation(WS_METHODS.pluginsConsent)),
        group.toLayerHandler(WS_METHODS.pluginsEnable, mutation(WS_METHODS.pluginsEnable)),
        group.toLayerHandler(WS_METHODS.pluginsDisable, mutation(WS_METHODS.pluginsDisable)),
        group.toLayerHandler(WS_METHODS.pluginsRemove, mutation(WS_METHODS.pluginsRemove)),
        group.toLayerHandler(WS_METHODS.pluginsResume, mutation(WS_METHODS.pluginsResume)),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );
};

/** Calls every management RPC and returns the tag each one failed with. */
const callWrites = (client: Effect.Success<ReturnType<typeof makeClient>>) =>
  Effect.all([
    client[WS_METHODS.pluginsAdd]({ directory: "/plugins/fixture" }).pipe(Effect.flip),
    client[WS_METHODS.pluginsRefresh]({}).pipe(Effect.flip),
    client[WS_METHODS.pluginsConsent]({ installationId, digest }).pipe(Effect.flip),
    client[WS_METHODS.pluginsEnable]({ installationId }).pipe(Effect.flip),
    client[WS_METHODS.pluginsDisable]({ installationId }).pipe(Effect.flip),
    client[WS_METHODS.pluginsRemove]({ installationId }).pipe(Effect.flip),
    client[WS_METHODS.pluginsResume]({ installationId }).pipe(Effect.flip),
  ]);

describe("plugin RPC scopes", () => {
  it.effect("lets a standard pairing read the catalogue but not change what runs", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(AuthStandardClientScopes, handled);

      expect(yield* client[WS_METHODS.pluginsList]({})).toEqual({ installations: [] });
      expect(
        yield* client[WS_METHODS.pluginsSubscribe]({}).pipe(Stream.take(1), Stream.runCollect),
      ).toEqual([{ installations: [] }]);

      const failures = yield* callWrites(client);
      for (const failure of failures) {
        expect(failure).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredScope: AuthAccessWriteScope,
          requiredPermission: AuthAccessWriteScope,
        });
      }
      expect(handled).toEqual([WS_METHODS.pluginsList, WS_METHODS.pluginsSubscribe]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets an administrative pairing manage plugins", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(AuthAdministrativeScopes, handled);

      const failures = yield* callWrites(client);
      for (const failure of failures) expect(failure._tag).toBe("PluginCatalogError");
      expect(handled).toEqual([...writes]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses catalogue reads without the orchestration read scope", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient([AuthRelayReadScope], handled);

      expect(yield* client[WS_METHODS.pluginsList]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(
        yield* client[WS_METHODS.pluginsSubscribe]({}).pipe(Stream.runCollect, Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
