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






























import { assertSameCallback, environmentIds, instanceId, makeHarnessFor, makeRenewalBroker, provision, makeHarness } from "./CodexChatGptAuth-fixtures.testkit.ts";

it.effect(
  "changing account registers a new user-owned client and then reuses that registration",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        h.setCallbackClientId("oaiapp_other_account");
        h.setIdentity("other-user", "other@example.test");
        yield* h.changeAccount;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[1]!.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        assert.strictEqual(h.exchanges[1]!.get("client_id"), "oaiapp_other_account");
        const saved = Option.getOrThrow(yield* h.auth.read);
        assert.strictEqual(saved.clientId, "oaiapp_other_account");
        assert.strictEqual(saved.subject, "other-user");
        assert.strictEqual(saved.email, "other@example.test");
        const redirectUri = h.authorizationRequests[1]!.searchParams.get("redirect_uri");
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[2]!.searchParams.get("client_id"),
          "oaiapp_other_account",
        );
        assertSameCallback(
          h.authorizationRequests[2]!.searchParams.get("redirect_uri"),
          redirectUri,
        );
      }),
    ),
);
it.effect.each(["identity", "sharing"] as const)(
  "failed account change preserves the original credentials and registration: %s",
  (failure) =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const before = h.storedRecords();
        h.setCallbackClientId("oaiapp_other_account");
        if (failure === "identity") h.setInvalidNonce();
        else h.declineSharing();
        yield* h.changeAccount;
        yield* h.phase("failed");
        assert.strictEqual(
          h.authorizationRequests[1]!.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        if (failure === "sharing") {
          assert.deepEqual(
            Option.getOrThrow(yield* h.auth.read),
            before.find((record) => record.accessToken),
          );
          assert.lengthOf(h.storedRecords().find((record) => record.profiles).profiles, 2);
        } else assert.deepEqual(h.storedRecords(), before);
      }),
    ),
);
it.effect("reauthorizes on an available port when the original callback port is occupied", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      const port = Number(
        new URL(h.authorizationRequests[0]!.searchParams.get("redirect_uri")!).port,
      );
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeHttp.Server>((resolve, reject) => {
              const server = NodeHttp.createServer();
              server.once("error", reject);
              server.listen(port, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      yield* h.signIn;
      yield* h.phase("succeeded");
      assert.notStrictEqual(
        Number(new URL(h.authorizationRequests[1]!.searchParams.get("redirect_uri")!).port),
        port,
      );
      assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("client_id"), "oaiapp_test");
      assert.strictEqual(h.exchanges.length, 2);
    }),
  ),
);
it.effect("reauthorizes a registration without persisting its original port", () =>
  provision(
    Effect.gen(function* () {
      const bytes = new Map<string, Uint8Array>();
      const h = yield* makeHarnessFor(instanceId, bytes);
      yield* h.signIn;
      yield* h.phase("succeeded");
      yield* h.auth.revoke;
      for (const [key, value] of bytes) {
        const record = JSON.parse(new TextDecoder().decode(value));
        if (record.profiles)
          bytes.set(key, new TextEncoder().encode(JSON.stringify({ clientId: "oaiapp_test" })));
      }
      yield* h.signIn;
      yield* h.phase("succeeded");
      assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("client_id"), "oaiapp_test");
      assert.strictEqual(new URL(h.exchanges[1]!.get("redirect_uri")!).hostname, "127.0.0.1");
    }),
  ),
);
it.effect(
  "separate Codex accounts register independently and disconnect only their own tokens",
  () =>
    provision(
      Effect.gen(function* () {
        const bytes = new Map<string, Uint8Array>();
        const personal = yield* makeHarnessFor(ProviderInstanceId.make("codex_personal"), bytes);
        const work = yield* makeHarnessFor(ProviderInstanceId.make("codex_work"), bytes);
        yield* personal.signIn;
        yield* personal.phase("succeeded");
        const personalCredentials = Option.getOrThrow(yield* personal.auth.read);
        assert.isTrue(Option.isNone(yield* work.auth.read));
        yield* work.signIn;
        yield* work.phase("succeeded");
        assert.strictEqual(
          work.authorizationRequests[0]!.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        assert.notStrictEqual(
          personal.auth.controller.credentialBinding?.key,
          work.auth.controller.credentialBinding?.key,
        );
        yield* work.auth.controller.logout(Effect.void);
        assert.isTrue(Option.isNone(yield* work.auth.read));
        assert.deepEqual(Option.getOrThrow(yield* personal.auth.read), personalCredentials);
      }),
    ),
);
it.effect(
  "emits the guide's first-time authorization request and fresh reauthorization values",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.include(
          h.callbackResponses[0]!.body,
          'content="1;url=http://localhost:7001/welcome"',
        );
        const first = h.authorizationRequests[0]!;
        assert.strictEqual(
          first.searchParams.get("ext_agent_host_id"),
          `urn:uuid:${h.environmentId}`,
        );
        assert.strictEqual(first.origin, h.origin);
        assert.strictEqual(first.pathname, "/authorize");
        assert.deepEqual(Array.from(first.searchParams.keys()).sort(), [
          "agent_name_hint",
          "client_id",
          "code_challenge",
          "code_challenge_method",
          "ext_agent_host_id",
          "nonce",
          "redirect_uri",
          "resource",
          "response_type",
          "scope",
          "state",
        ]);
        assert.strictEqual(first.searchParams.get("client_id"), "dynamic_agent_client");
        assert.strictEqual(first.searchParams.get("agent_name_hint"), "T3 Code");
        assert.strictEqual(first.searchParams.get("response_type"), "code");
        assert.strictEqual(
          first.searchParams.get("scope"),
          "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        );
        assert.strictEqual(first.searchParams.get("resource"), `${h.origin}/v1`);
        assert.strictEqual(first.searchParams.get("code_challenge_method"), "S256");
        const callback = new URL(first.searchParams.get("redirect_uri")!);
        assert.strictEqual(callback.protocol, "http:");
        assert.strictEqual(callback.hostname, "127.0.0.1");
        assert.strictEqual(callback.pathname, "/auth/callback");
        assert.isAbove(Number(callback.port), 0);
        for (const key of ["state", "nonce", "code_challenge"]) {
          assert.match(first.searchParams.get(key)!, /^[A-Za-z0-9_-]{43}$/u);
        }
        assert.notStrictEqual(first.searchParams.get("state"), first.searchParams.get("nonce"));
        const originalIdToken = Option.getOrThrow(yield* h.auth.read).idToken;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const second = h.authorizationRequests[1]!;
        assert.strictEqual(second.searchParams.get("client_id"), "oaiapp_test");
        assert.isFalse(second.searchParams.has("agent_name_hint"));
        assert.strictEqual(second.searchParams.get("login_hint"), "hidden@example.test");
        assert.strictEqual(second.searchParams.get("id_token_hint"), originalIdToken);
        assert.strictEqual(
          second.searchParams.get("ext_agent_host_id"),
          first.searchParams.get("ext_agent_host_id"),
        );
        assertSameCallback(
          second.searchParams.get("redirect_uri"),
          first.searchParams.get("redirect_uri"),
        );
        assert.deepEqual(
          Array.from(second.searchParams.keys()).sort(),
          [
            ...Array.from(first.searchParams.keys()).filter((key) => key !== "agent_name_hint"),
            "login_hint",
            "id_token_hint",
          ].sort(),
        );
        for (const key of ["state", "nonce", "code_challenge"]) {
          assert.notStrictEqual(first.searchParams.get(key), second.searchParams.get(key));
        }
        yield* h.auth.controller.logout(Effect.void);
        yield* h.signIn;
        yield* h.phase("succeeded");
        const reconnect = h.authorizationRequests[2]!;
        assert.strictEqual(reconnect.searchParams.get("client_id"), "oaiapp_test");
        assertSameCallback(
          reconnect.searchParams.get("redirect_uri"),
          first.searchParams.get("redirect_uri"),
        );
        assert.isFalse(reconnect.searchParams.has("agent_name_hint"));
        assert.isFalse(reconnect.searchParams.has("id_token_hint"));
        assert.strictEqual(reconnect.searchParams.get("login_hint"), "hidden@example.test");
        assert.strictEqual(
          reconnect.searchParams.get("ext_agent_host_id"),
          first.searchParams.get("ext_agent_host_id"),
        );
        assert.strictEqual(
          h.exchanges[2]!.get("redirect_uri"),
          reconnect.searchParams.get("redirect_uri"),
        );
      }),
    ),
);
it.effect(
  "returns to the initiating client only after sign-in has verified and saved credentials",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        h.setReturnUrl(
          "http://localhost:7001/settings/providers?instanceId=codex_work&code=secret-code",
        );
        yield* h.signIn;
        assert.isTrue(Option.isSome(yield* h.auth.read));
        const response = h.callbackResponses[0]!;
        assert.include(response.headers.get("content-type")!, "text/html");
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
        assert.strictEqual(response.headers.get("referrer-policy"), "no-referrer");
        assert.include(response.headers.get("content-security-policy")!, "default-src 'none'");
        assert.include(response.body, "You're signed in".replace("'", "&#39;"));
        assert.include(
          response.body,
          'content="1;url=http://localhost:7001/settings/providers?instanceId=codex_work"',
        );
        assert.notInclude(response.body, "secret-code");
        assert.include(response.body, 'history.replaceState(null,"","/auth/callback")');
        assert.notInclude(response.body, "authorization-code");
        assert.notInclude(response.body, "initial-access");
        assert.notInclude(response.body, "hidden@example.test");
      }),
    ),
);
it.effect(
  "does not redirect to an arbitrary return URL or claim success after verification fails",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        h.setReturnUrl("https://attacker.example/welcome");
        h.setInvalidNonce();
        yield* h.signIn;
        yield* h.phase("failed");
        const response = h.callbackResponses[0]!;
        assert.include(response.body, "Sign-in couldn&#39;t finish");
        assert.notInclude(response.body, 'http-equiv="refresh"');
        assert.notInclude(response.body, "attacker.example");
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);
it.effect(
  "verifies registration, PKCE, identity and persists rotating refresh before concurrent access",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(Option.getOrThrow(yield* h.auth.read).subject, "user-test");
        assert.strictEqual(h.exchanges[0]?.get("client_id"), "oaiapp_test");
        yield* h.seedExpired;
        const records = yield* Effect.all([h.auth.access, h.auth.access], {
          concurrency: "unbounded",
        });
        assert.strictEqual(h.refreshes(), 1);
        assert.strictEqual(records[0].accessToken, "access-1");
        assert.strictEqual(records[1].refreshToken, "refresh-1");
        assert.isNull(h.exchanges[1]?.get("scope"));
        yield* h.auth.controller.logout(Effect.void);
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);
it.effect("rejects invalid ID token nonce without saving credentials", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.setInvalidNonce();
      yield* h.signIn;
      assert.include((yield* h.phase("failed")).message!, "could not be verified");
      assert.isTrue(Option.isNone(yield* h.auth.read));
    }),
  ),
);
it.effect("retains identity after declined sharing but never admits inference", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.declineSharing();
      yield* h.signIn;
      yield* h.phase("failed");
      assert.isTrue(Option.isSome(yield* h.auth.read));
      const result = yield* h.auth.access.pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(h.refreshes(), 0);
    }),
  ),
);
it.effect("clears revoked refresh credentials and does not replay them", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      yield* h.seedExpired;
      h.setRevoked();
      yield* h.auth.access.pipe(Effect.result);
      yield* h.auth.access.pipe(Effect.result);
      assert.strictEqual(h.refreshes(), 1);
      assert.isTrue(Option.isNone(yield* h.auth.read));
    }),
  ),
);
it.effect(
  "preserves credentials through temporary renewal failure and retries the latest refresh",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        yield* h.seedExpired;
        h.setTransient(true);
        yield* h.auth.access.pipe(Effect.result);
        assert.strictEqual(Option.getOrThrow(yield* h.auth.read).refreshToken, "initial-refresh");
        h.setTransient(false);
        const renewed = yield* h.auth.access;
        assert.strictEqual(renewed.refreshToken, "refresh-2");
        assert.strictEqual(h.exchanges.at(-1)?.get("refresh_token"), "initial-refresh");
      }),
    ),
);
it.effect(
  "disconnect retains the remembered account profile while a different account registers afresh",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[0]?.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        yield* h.auth.controller.logout(Effect.void);
        assert.isTrue(Option.isNone(yield* h.auth.read));
        assert.deepEqual(h.storedRecords(), [
          {
            profiles: [
              {
                clientId: "oaiapp_test",
                connectionLabel: "Connection 1",
                sharingEnabled: true,
                redirectUri: h.authorizationRequests[0]!.searchParams.get("redirect_uri"),
                subject: "user-test",
                email: "hidden@example.test",
              },
            ],
            lastClientId: "oaiapp_test",
          },
        ]);
        const disconnected = yield* h.auth.controller
          .subscribe("owner")
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        assert.include(
          disconnected.methods!.find((method) => method.id === "chatgpt")!.description!,
          "hidden@example.test",
        );
        assert.strictEqual(
          disconnected.methods!.find((method) => method.id === "chatgpt")!.accountEmail,
          "hidden@example.test",
        );
        assert.strictEqual(
          disconnected.methods!.find((method) => method.id === "chatgpt-profile:oaiapp_test")!
            .accountEmail,
          "hidden@example.test",
        );
        assert.strictEqual((yield* h.auth.access.pipe(Effect.result))._tag, "Failure");
        assert.strictEqual(h.refreshes(), 0);
        h.setCallbackClientId("oaiapp_different_workspace");
        h.setIdentity("different-user", "different@example.test");
        yield* h.changeAccount;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[1]?.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        assert.strictEqual(h.exchanges[1]?.get("client_id"), "oaiapp_different_workspace");
        assert.strictEqual(Option.getOrThrow(yield* h.auth.read).subject, "different-user");
      }),
    ),
);
it.effect("rejects mismatched callback state before any token exchange or credential write", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.mismatchCallbackState();
      yield* h.signIn;
      assert.include((yield* h.phase("failed")).message!, "could not be verified");
      assert.strictEqual(h.exchanges.length, 0);
      assert.deepEqual(h.storedRecords(), []);
      assert.isTrue(Option.isNone(yield* h.auth.read));
    }),
  ),
);
it.effect.each(["issuer", "audience", "signature"] as const)(
  "rejects ID token %s verification before saving tokens or registration",
  (invalidClaim) =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        h.setIdentityFailure(invalidClaim);
        yield* h.signIn;
        assert.include((yield* h.phase("failed")).message!, "could not be verified");
        assert.strictEqual(h.exchanges.length, 1);
        assert.deepEqual(h.storedRecords(), []);
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);
it.effect.each([
  { revoked: false, label: "without changing the current account" },
  { revoked: true, label: "after token removal" },
])("rejects conflicting callback client ID on reauthorization $label", ({ revoked }) =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      if (revoked) yield* h.auth.revoke;
      const before = h.storedRecords();
      h.setCallbackClientId("oaiapp_untrusted_callback");
      yield* h.signIn;
      assert.include((yield* h.phase("failed")).message!, "registration is incomplete");
      assert.strictEqual(h.authorizationRequests[1]?.searchParams.get("client_id"), "oaiapp_test");
      assert.strictEqual(h.exchanges.length, 1);
      assert.deepEqual(h.storedRecords(), before);
      assert.strictEqual(Option.isNone(yield* h.auth.read), revoked);
    }),
  ),
);
it.effect(
  "completes remote sign-in on the owning environment and reuses its exact callback for reauthorization",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarnessFor(instanceId);
      const first = yield* harness.startRemote();
      assert.isTrue(
        first.waiting.interaction?.type === "browser" && first.waiting.interaction.acceptsCallback,
      );
      yield* harness.auth.controller.complete("owner", {
        flowId: first.waiting.flowId!,
        callbackUrl: first.callbackUrl,
      });
      yield* harness.phase("succeeded");
      assert.strictEqual(Option.getOrThrow(yield* harness.auth.read).email, "hidden@example.test");
      const second = yield* harness.startRemote();
      assertSameCallback(second.callbackUrl, first.callbackUrl);
      assert.strictEqual(
        new URL(second.waiting.authorizationUrl!).searchParams.get("client_id"),
        "oaiapp_test",
      );
      yield* harness.auth.controller.complete("owner", {
        flowId: second.waiting.flowId!,
        callbackUrl: second.callbackUrl,
      });
      yield* harness.phase("succeeded");
      assert.strictEqual(harness.exchanges.length, 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, FetchHttpClient.layer),
      ),
    ),
);
it.effect(
  "rejects foreign clients and malformed remote callbacks without consuming the owner's sign-in",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarnessFor(instanceId);
      const { waiting, callbackUrl } = yield* harness.startRemote();
      assert.isTrue(Option.isNone(yield* harness.auth.read));
      yield* Effect.flip(
        harness.auth.controller.complete("other-client", { flowId: waiting.flowId!, callbackUrl }),
      );
      const wrongPort = new URL(callbackUrl);
      wrongPort.port = wrongPort.port === "65535" ? "65534" : "65535";
      for (const invalid of [
        wrongPort.toString(),
        callbackUrl.replace("/auth/callback", "/other"),
        callbackUrl + "&state=foreign",
        callbackUrl + "&code=duplicate",
        callbackUrl + "&error=access_denied",
        callbackUrl.replace("127.0.0.1", "attacker.example"),
      ]) {
        yield* Effect.flip(
          harness.auth.controller.complete("owner", {
            flowId: waiting.flowId!,
            callbackUrl: invalid,
          }),
        );
      }
      assert.strictEqual(harness.exchanges.length, 0);
      assert.isTrue(Option.isNone(yield* harness.auth.read));
      yield* harness.auth.controller.complete("owner", { flowId: waiting.flowId!, callbackUrl });
      yield* harness.phase("succeeded");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, FetchHttpClient.layer),
      ),
    ),
);
it.effect("keeps simultaneous remote accounts and environments independent", () =>
  Effect.gen(function* () {
    const first = yield* makeHarnessFor(instanceId);
    const second = yield* makeHarnessFor(instanceId);
    second.setIdentity("other-user", "other@example.test");
    second.setCallbackClientId("oaiapp_other");
    const a = yield* first.startRemote();
    const b = yield* second.startRemote();
    assert.notStrictEqual(
      new URL(a.waiting.authorizationUrl!).searchParams.get("ext_agent_host_id"),
      new URL(b.waiting.authorizationUrl!).searchParams.get("ext_agent_host_id"),
    );
    yield* Effect.flip(
      first.auth.controller.complete("owner", {
        flowId: a.waiting.flowId!,
        callbackUrl: b.callbackUrl,
      }),
    );
    yield* first.auth.controller.complete("owner", {
      flowId: a.waiting.flowId!,
      callbackUrl: a.callbackUrl,
    });
    yield* second.auth.controller.complete("owner", {
      flowId: b.waiting.flowId!,
      callbackUrl: b.callbackUrl,
    });
    yield* first.phase("succeeded");
    yield* second.phase("succeeded");
    assert.strictEqual(Option.getOrThrow(yield* first.auth.read).subject, "user-test");
    assert.strictEqual(Option.getOrThrow(yield* second.auth.read).subject, "other-user");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, FetchHttpClient.layer),
    ),
  ),
);
it.effect(
  "reconnects after Disconnect and restart with the same client and host on an available port",
  () =>
    provision(
      Effect.gen(function* () {
        const bytes = new Map<string, Uint8Array>();
        const first = yield* makeHarnessFor(instanceId, bytes);
        yield* first.signIn;
        yield* first.phase("succeeded");
        const redirectUri = first.authorizationRequests[0]!.searchParams.get("redirect_uri");
        yield* first.auth.controller.logout(Effect.void);
        const restarted = yield* makeHarnessFor(instanceId, bytes);
        yield* restarted.signIn;
        yield* restarted.phase("succeeded");
        assert.strictEqual(
          restarted.authorizationRequests[0]!.searchParams.get("client_id"),
          "oaiapp_test",
        );
        assertSameCallback(
          restarted.authorizationRequests[0]!.searchParams.get("redirect_uri"),
          redirectUri,
        );
        assert.strictEqual(
          restarted.exchanges[0]!.get("redirect_uri"),
          restarted.authorizationRequests[0]!.searchParams.get("redirect_uri"),
        );
        assert.strictEqual(Option.getOrThrow(yield* restarted.auth.read).subject, "user-test");
      }),
    ),
);
