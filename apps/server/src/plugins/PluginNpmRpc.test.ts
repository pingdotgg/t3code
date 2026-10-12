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
import * as RpcTest from "effect/rpc/RpcTest";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const writes = [
  WS_METHODS.pluginsNpmAdd,
  WS_METHODS.pluginsNpmStageUpdate,
  WS_METHODS.pluginsNpmApplyUpdate,
  WS_METHODS.pluginsNpmDiscardUpdate,
] as const;
type NpmMethod = typeof WS_METHODS.pluginsNpmList | (typeof writes)[number];
const npmMethods: ReadonlySet<string> = new Set([WS_METHODS.pluginsNpmList, ...writes]);

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, NpmMethod> => !npmMethods.has(tag),
  ),
);

const installationId = PluginInstallationId.make("fixture");
const digest = `sha256:${"0".repeat(64)}`;

/** Serves the npm RPCs through the real scope middleware; handlers record that they ran. */
const makeClient = (scopes: ReadonlyArray<AuthEnvironmentScope>, handled: Array<string>) => {
  // Mutations answer with a catalogue error: reaching it proves the middleware let the call in.
  const mutation = (method: string) => () =>
    Effect.sync(() => handled.push(method)).pipe(
      Effect.andThen(
        Effect.fail(new PluginCatalogError({ reason: "npm-not-found", message: "fixture" })),
      ),
    );
  return RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.pluginsNpmList, () =>
          Effect.sync(() => handled.push(WS_METHODS.pluginsNpmList)).pipe(
            Effect.as({ packages: [] }),
          ),
        ),
        group.toLayerHandler(WS_METHODS.pluginsNpmAdd, mutation(WS_METHODS.pluginsNpmAdd)),
        group.toLayerHandler(
          WS_METHODS.pluginsNpmStageUpdate,
          mutation(WS_METHODS.pluginsNpmStageUpdate),
        ),
        group.toLayerHandler(
          WS_METHODS.pluginsNpmApplyUpdate,
          mutation(WS_METHODS.pluginsNpmApplyUpdate),
        ),
        group.toLayerHandler(
          WS_METHODS.pluginsNpmDiscardUpdate,
          mutation(WS_METHODS.pluginsNpmDiscardUpdate),
        ),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );
};

/** Calls every npm mutation and returns what each one failed with. */
const callWrites = (client: Effect.Success<ReturnType<typeof makeClient>>) =>
  Effect.all([
    client[WS_METHODS.pluginsNpmAdd]({ name: "t3-plugin-hello", version: "1.0.0" }).pipe(
      Effect.flip,
    ),
    client[WS_METHODS.pluginsNpmStageUpdate]({ installationId, version: "1.1.0" }).pipe(
      Effect.flip,
    ),
    client[WS_METHODS.pluginsNpmApplyUpdate]({ installationId, digest }).pipe(Effect.flip),
    client[WS_METHODS.pluginsNpmDiscardUpdate]({ installationId }).pipe(Effect.flip),
  ]);

describe("npm plugin RPC scopes", () => {
  it.effect("lets a standard pairing list npm packages but not install or update them", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(AuthStandardClientScopes, handled);

      expect(yield* client[WS_METHODS.pluginsNpmList]({})).toEqual({ packages: [] });
      for (const failure of yield* callWrites(client)) {
        expect(failure).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredScope: AuthAccessWriteScope,
          requiredPermission: AuthAccessWriteScope,
        });
      }
      expect(handled).toEqual([WS_METHODS.pluginsNpmList]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets an administrative pairing install and update from npm", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(AuthAdministrativeScopes, handled);

      for (const failure of yield* callWrites(client)) {
        expect(failure).toMatchObject({ _tag: "PluginCatalogError", reason: "npm-not-found" });
      }
      expect(handled).toEqual([...writes]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses the package list without the orchestration read scope", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient([AuthRelayReadScope], handled);

      expect(yield* client[WS_METHODS.pluginsNpmList]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
