// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Local mock OAuth server validates the browser callback boundary.
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { subscribeChatGptHandoff } from "./CodexChatGptHandoff.ts";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";






























import { assertSameCallback, environmentIds, instanceId, makeHarnessFor, makeRenewalBroker, brokerClient } from "./CodexChatGptAuth-fixtures.testkit.ts";

const provideBroker = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-renewal-test-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
      ),
    ),
  );

// regression: #16132 a renewal must outlive the Codex helper that asked for it, because the
// refresh token it spends is single-use.
it.effect("server-owned renewal persists rotated credentials after the helper disconnects", () =>
  provideBroker(
    Effect.gen(function* () {
      const h = yield* makeRenewalBroker;
      h.pause();
      const client = yield* brokerClient(h.endpoint, h.request);
      yield* Deferred.await(h.oauthEntered);
      client.socket.destroy();
      yield* Effect.promise(() => client.response);
      assert.equal(Option.getOrThrow(yield* h.auth.read).refreshToken, "single-use-refresh");
      yield* Deferred.succeed(h.oauthRelease, undefined);
      yield* h.broker.awaitIdle;
      const persisted = Option.getOrThrow(yield* h.auth.read);
      assert.equal(persisted.refreshToken, "rotated-refresh");
      assert.equal((yield* h.auth.access).accessToken, "renewed-access");
      assert.deepEqual(h.refreshTokens, ["single-use-refresh"]);
    }),
  ),
);
it.live("the private broker refuses another environment, instance, or sign-in profile", () =>
  provideBroker(
    Effect.gen(function* () {
      const h = yield* makeRenewalBroker;
      yield* Effect.forEach(
        [
          {
            ...h.request,
            environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000002"),
          },
          { ...h.request, instanceId: ProviderInstanceId.make("another-instance") },
          { ...h.request, profileKey: "0".repeat(64) },
        ],
        (request) =>
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* brokerClient(h.endpoint, request);
              assert.equal(yield* Effect.promise(() => client.response), "");
            }),
          ),
      );
      yield* h.broker.awaitIdle;
      assert.deepEqual(h.refreshTokens, []);
      const client = yield* brokerClient(h.endpoint, h.request);
      assert.deepEqual(JSON.parse(yield* Effect.promise(() => client.response)), {
        token: "renewed-access",
      });
      yield* h.broker.awaitIdle;
      assert.deepEqual(h.refreshTokens, ["single-use-refresh"]);
    }),
  ),
);
