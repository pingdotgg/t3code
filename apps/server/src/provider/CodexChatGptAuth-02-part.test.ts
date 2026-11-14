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

it.effect.each([
  { disconnected: false, label: "while connected" },
  { disconnected: true, label: "after Disconnect" },
])("rejects a different verified identity during saved-profile reauth $label", ({ disconnected }) =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      if (disconnected) yield* h.auth.controller.logout(Effect.void);
      const before = h.storedRecords();
      h.setIdentity("another-user", "another@example.test");
      yield* h.signIn;
      assert.include((yield* h.phase("failed")).message!, "different ChatGPT account");
      assert.deepEqual(h.storedRecords(), before);
      assert.strictEqual(Option.isNone(yield* h.auth.read), disconnected);
    }),
  ),
);
it.effect(
  "retains both profiles and reuses the original account's client and callback when returning from another account",
  () =>
    provision(
      Effect.gen(function* () {
        const bytes = new Map<string, Uint8Array>();
        const first = yield* makeHarnessFor(instanceId, bytes);
        yield* first.signIn;
        yield* first.phase("succeeded");
        const redirectUri = first.authorizationRequests[0]!.searchParams.get("redirect_uri");
        first.setIdentity("other-user", "other@example.test");
        first.setCallbackClientId("oaiapp_other_account");
        yield* first.changeAccount;
        const changed = yield* first.phase("succeeded");
        assert.isTrue(
          changed.methods!.some((method) => method.id === "chatgpt-profile:oaiapp_test"),
        );
        assert.isTrue(
          changed.methods!.some((method) => method.id === "chatgpt-profile:oaiapp_other_account"),
        );
        yield* first.auth.controller.logout(Effect.void);
        const restarted = yield* makeHarnessFor(instanceId, bytes);
        yield* restarted.reconnectProfile("oaiapp_test");
        yield* restarted.phase("succeeded");
        assert.strictEqual(
          restarted.authorizationRequests[0]!.searchParams.get("client_id"),
          "oaiapp_test",
        );
        assertSameCallback(
          restarted.authorizationRequests[0]!.searchParams.get("redirect_uri"),
          redirectUri,
        );
        assert.strictEqual(Option.getOrThrow(yield* restarted.auth.read).subject, "user-test");
      }),
    ),
);
it.effect("preserves legacy profiles with the same email and subject", () =>
  provision(
    Effect.gen(function* () {
      const bytes = new Map<string, Uint8Array>();
      const h = yield* makeHarnessFor(instanceId, bytes);
      yield* h.signIn;
      yield* h.phase("succeeded");
      const redirectUri = h.authorizationRequests[0]!.searchParams.get("redirect_uri");
      for (const [key, value] of bytes) {
        const record = JSON.parse(new TextDecoder().decode(value));
        if (record.profiles)
          bytes.set(
            key,
            new TextEncoder().encode(
              JSON.stringify({
                ...record,
                profiles: [
                  { ...record.profiles[0], clientId: "oaiapp_old_duplicate" },
                  ...record.profiles,
                ],
              }),
            ),
          );
      }
      const restarted = yield* makeHarnessFor(instanceId, bytes);
      const state = yield* restarted.auth.controller.subscribe("owner").pipe(
        Stream.filter((state) => state.methods != null),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.deepEqual(
        state
          .methods!.filter((method) => method.id.startsWith("chatgpt-profile:"))
          .map((method) => method.id),
        ["chatgpt-profile:oaiapp_test", "chatgpt-profile:oaiapp_old_duplicate"],
      );
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
      assert.lengthOf(restarted.storedRecords().find((record) => record.profiles).profiles, 2);
    }),
  ),
);
it.effect("keeps distinct verified identities even when their email matches", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      h.setIdentity("other-user", "hidden@example.test");
      h.setCallbackClientId("oaiapp_other_account");
      yield* h.changeAccount;
      const changed = yield* h.phase("succeeded");
      assert.lengthOf(
        changed.methods!.filter((method) => method.id.startsWith("chatgpt-profile:")),
        2,
      );
    }),
  ),
);
it.effect(
  "migrates a legacy registration and retains its verified identity when credentials are cleared",
  () =>
    provision(
      Effect.gen(function* () {
        const bytes = new Map<string, Uint8Array>();
        const first = yield* makeHarnessFor(instanceId, bytes);
        yield* first.signIn;
        yield* first.phase("succeeded");
        const redirectUri = first.authorizationRequests[0]!.searchParams.get("redirect_uri");
        for (const [key, value] of bytes) {
          const saved = JSON.parse(new TextDecoder().decode(value));
          if (saved.profiles)
            bytes.set(
              key,
              new TextEncoder().encode(JSON.stringify({ clientId: "oaiapp_test", redirectUri })),
            );
        }
        yield* first.auth.revoke;
        assert.deepEqual(first.storedRecords(), [
          {
            profiles: [
              {
                clientId: "oaiapp_test",
                connectionLabel: "Connection 1",
                redirectUri,
                subject: "user-test",
                email: "hidden@example.test",
              },
            ],
            lastClientId: "oaiapp_test",
          },
        ]);
        const restarted = yield* makeHarnessFor(instanceId, bytes);
        restarted.setIdentity("another-user", "another@example.test");
        yield* restarted.signIn;
        assert.include((yield* restarted.phase("failed")).message!, "different ChatGPT account");
        assert.isTrue(Option.isNone(yield* restarted.auth.read));
        assert.strictEqual(
          restarted.authorizationRequests[0]!.searchParams.get("ext_agent_host_id"),
          first.authorizationRequests[0]!.searchParams.get("ext_agent_host_id"),
        );
      }),
    ),
);
it.effect("declined sharing on an older profile does not replace the active account", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      h.setIdentity("other-user", "other@example.test");
      h.setCallbackClientId("oaiapp_other_account");
      yield* h.changeAccount;
      yield* h.phase("succeeded");
      const before = h.storedRecords();
      h.setIdentity("user-test", "hidden@example.test");
      h.setCallbackClientId("oaiapp_test");
      h.declineSharing();
      yield* h.reconnectProfile("oaiapp_test");
      assert.include(
        (yield* h.phase("failed")).message!,
        "existing ChatGPT connection is unchanged",
      );
      assert.deepEqual(
        Option.getOrThrow(yield* h.auth.read),
        before.find((record) => record.clientId === "oaiapp_other_account"),
      );
    }),
  ),
);
it.effect.each([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
  "invalid_token",
])("refresh recovery follows the machine-readable code: %s", (code) =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      yield* h.seedExpired;
      h.setRefreshError(code);
      yield* Effect.flip(h.auth.access);
      assert.strictEqual(
        Option.isNone(yield* h.auth.read),
        !["invalid_client", "invalid_token"].includes(code),
      );
      assert.isTrue(
        h
          .storedRecords()
          .some((record) =>
            record.profiles?.some(
              (profile: { clientId: string }) => profile.clientId === "oaiapp_test",
            ),
          ),
      );
    }),
  ),
);
it.effect(
  "logout revokes the latest refresh token with the selected client and clears its ID hint",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const host = h.authorizationRequests[0]!.searchParams.get("ext_agent_host_id");
        assert.match(host!, /^urn:uuid:[0-9a-f-]{36}$/u);
        yield* h.seedExpired;
        yield* h.auth.access;
        const state = yield* h.auth.controller.logout(Effect.void);
        assert.strictEqual(state.message, "Signed out.");
        assert.deepEqual(Array.from(h.revocations[0]!), [
          ["token", "refresh-1"],
          ["token_type_hint", "refresh_token"],
          ["client_id", "oaiapp_test"],
        ]);
        assert.isTrue(Option.isNone(yield* h.auth.read));
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.isFalse(h.authorizationRequests[1]!.searchParams.has("id_token_hint"));
        assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("ext_agent_host_id"), host);
      }),
    ),
);
it.effect(
  "reauth hints come from the selected profile, including after another profile logs out",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const personal = Option.getOrThrow(yield* h.auth.read);
        h.setCallbackClientId("oaiapp_work");
        h.setIdentity("work-user", "work@example.test");
        yield* h.changeAccount;
        yield* h.phase("succeeded");
        assert.isFalse(h.authorizationRequests[1]!.searchParams.has("id_token_hint"));
        assert.isFalse(h.authorizationRequests[1]!.searchParams.has("login_hint"));
        yield* h.auth.controller.logout(Effect.void);
        h.setCallbackClientId("oaiapp_test");
        h.setIdentity("user-test", "hidden@example.test");
        yield* h.reconnectProfile("oaiapp_test");
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[2]!.searchParams.get("id_token_hint"),
          personal.idToken,
        );
        assert.strictEqual(
          h.authorizationRequests[2]!.searchParams.get("login_hint"),
          personal.email,
        );
      }),
    ),
);
it.effect("an expired initial code retains the issued ID for a fresh authorization", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.setCodeError("invalid_grant");
      yield* h.signIn;
      const failed = yield* h.phase("failed");
      assert.isTrue(Option.isNone(yield* h.auth.read));
      assert.isTrue(failed.methods!.some((method) => method.id === "chatgpt-profile:oaiapp_test"));
      h.setCodeError(undefined);
      yield* h.reconnectProfile("oaiapp_test");
      yield* h.phase("succeeded");
      assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("client_id"), "oaiapp_test");
      assert.notStrictEqual(
        h.authorizationRequests[0]!.searchParams.get("state"),
        h.authorizationRequests[1]!.searchParams.get("state"),
      );
    }),
  ),
);
it.effect("identity-only sign-in requests consent on an explicit retry, then rechecks scopes", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.declineSharing();
      yield* h.signIn;
      yield* h.phase("failed");
      yield* h.reconnectProfile("oaiapp_test");
      yield* h.phase("failed");
      assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("prompt"), "consent");
      assert.isFalse(h.authorizationRequests[1]!.searchParams.has("force_reconsent"));
      assert.include(
        h.authorizationRequests[1]!.searchParams.get("scope")!,
        "chatgpt.tokens.use.direct",
      );
      yield* Effect.flip(h.auth.access);
    }),
  ),
);
it.effect(
  "controller replacement shares refresh serialization for the same environment session",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const replacement = yield* h.recreateAuth;
        yield* h.seedExpired;
        const records = yield* Effect.all([h.auth.access, replacement.access], {
          concurrency: "unbounded",
        });
        assert.strictEqual(h.refreshes(), 1);
        assert.strictEqual(records[0].refreshToken, "refresh-1");
        assert.deepEqual(records[0], records[1]);
      }),
    ),
);
it.effect(
  "old localhost registrations retain their profile while a new client gets its own identity",
  () =>
    provision(
      Effect.gen(function* () {
        const bytes = new Map<string, Uint8Array>();
        const h = yield* makeHarnessFor(instanceId, bytes);
        yield* h.signIn;
        yield* h.phase("succeeded");
        for (const [key, value] of bytes) {
          const record = JSON.parse(new TextDecoder().decode(value));
          if (record.profiles)
            bytes.set(
              key,
              new TextEncoder().encode(
                JSON.stringify({
                  ...record,
                  profiles: record.profiles.map((profile: { redirectUri: string }) => ({
                    ...profile,
                    redirectUri: profile.redirectUri.replace("127.0.0.1", "localhost"),
                  })),
                }),
              ),
            );
        }
        h.setCallbackClientId("oaiapp_migrated");
        h.setIdentity("new-client-subject", "hidden@example.test");
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[1]!.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        assert.strictEqual(
          new URL(h.authorizationRequests[1]!.searchParams.get("redirect_uri")!).hostname,
          "127.0.0.1",
        );
        assert.strictEqual(Option.getOrThrow(yield* h.auth.read).subject, "new-client-subject");
        const profiles = (yield* h.phase("succeeded")).methods!;
        assert.isTrue(profiles.some((profile) => profile.id === "chatgpt-profile:oaiapp_test"));
        assert.isTrue(profiles.some((profile) => profile.id === "chatgpt-profile:oaiapp_migrated"));
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[2]!.searchParams.get("client_id"),
          "oaiapp_migrated",
        );
        assert.strictEqual(
          h.authorizationRequests[2]!.searchParams.get("login_hint"),
          "hidden@example.test",
        );
        assert.isTrue(h.authorizationRequests[2]!.searchParams.has("id_token_hint"));
      }),
    ),
);
it.effect("primary completes OAuth and destination imports and owns the refresh session", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const destination = yield* h.destination;
      const before = h.bytes.size;
      const waiting = yield* Deferred.make<{ authorizationUrl: string | null }>();
      const transferred = yield* h.handoff(null).pipe(
        Stream.tap((state) =>
          state.phase === "auth" && state.state.phase === "waiting"
            ? Deferred.succeed(waiting, state.state)
            : Effect.void,
        ),
        Stream.filter((state) => state.phase === "finished"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.forkChild,
      );
      yield* h.finishCallback(yield* Deferred.await(waiting));
      const result = yield* Fiber.join(transferred);
      assert.strictEqual(result.phase, "finished");
      if (result.phase !== "finished") return;
      assert.strictEqual(h.bytes.size, before);
      assert.isTrue(Option.isNone(yield* h.auth.read));
      let stopped = false;
      const imported = yield* destination.auth.controller.importProfile!(
        result.profile,
        Effect.sync(() => {
          stopped = true;
        }),
      );
      assert.isTrue(stopped);
      assert.strictEqual(imported.phase, "succeeded");
      assert.deepStrictEqual(
        h.analyticsEvents.map(({ event }) => event),
        [
          "chatgpt.auth.started",
          "chatgpt.auth.completed",
          "chatgpt.transfer.started",
          "chatgpt.transfer.completed",
        ],
      );
      assert.isTrue(
        h.analyticsEvents.every(({ properties }) => properties?.flow === "primary_handoff"),
      );
      assert.strictEqual(h.analyticsEvents[1]?.properties?.outcome, "succeeded");
      assert.strictEqual(h.analyticsEvents[3]?.properties?.outcome, "succeeded");
      assert.notProperty(h.analyticsEvents[1]?.properties ?? {}, "connectedAccountCount");
      assert.strictEqual(h.analyticsEvents[1]?.properties?.intent, "different_account");
      assert.strictEqual(h.analyticsEvents[3]?.properties?.connectedAccountCount, 1);
      assert.strictEqual(h.analyticsEvents[3]?.properties?.savedConnectionCount, 1);
      const saved = Option.getOrThrow(yield* destination.auth.read);
      assert.strictEqual(saved.clientId, result.profile.registration.clientId);
      assert.strictEqual(saved.refreshToken, "initial-refresh");
      const reconnect = yield* destination.auth.controller.reconnectProfile!("chatgpt");
      assert.strictEqual(reconnect?.idTokenHint, result.profile.credentials.idToken);
      assert.isFalse("refreshToken" in reconnect!);
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId).pipe(
        Effect.provideService(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: (name) => Effect.sync(() => Option.fromUndefinedOr(destination.bytes.get(name))),
            set: (name, value) =>
              Effect.sync(() => {
                destination.bytes.set(name, value);
              }),
            remove: () => Effect.void,
            create: () => Effect.die("unused"),
            getOrCreateRandom: () => Effect.die("unused"),
          }),
        ),
      );
      yield* store.set(new TextEncoder().encode(JSON.stringify({ ...saved, expiresAt: 0 })));
      yield* destination.auth.access;
      assert.strictEqual(
        h.exchanges.filter((entry) => entry.get("grant_type") === "authorization_code").length,
        1,
      );
      assert.strictEqual(
        h.exchanges.filter((entry) => entry.get("grant_type") === "refresh_token").length,
        1,
      );
    }),
  ),
);
it.effect("transferred profiles reject mismatched identities without overwriting credentials", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      const profile = yield* h.auth.exportProfile;
      const destination = yield* h.destination;
      yield* destination.auth.controller.importProfile!(profile, Effect.void);
      const original = Option.getOrThrow(yield* destination.auth.read);
      for (const credentials of [
        { ...profile.credentials, subject: "wrong-user" },
        { ...profile.credentials, clientId: "oaiapp_wrong" },
        { ...profile.credentials, idToken: "not-a-jwt" },
        { ...profile.credentials, scopes: ["openid"] },
        { ...profile.credentials, expiresAt: 0 },
      ]) {
        const result = yield* destination.auth.controller.importProfile!(
          { ...profile, credentials },
          Effect.void,
        ).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.deepEqual(Option.getOrThrow(yield* destination.auth.read), original);
      }
    }),
  ),
);
it.effect("primary handoff reuses the selected registration and ID token hint", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      const profile = yield* h.auth.controller.reconnectProfile!("chatgpt");
      const waiting = yield* Deferred.make<{ authorizationUrl: string | null }>();
      const resultFiber = yield* h.handoff(profile).pipe(
        Stream.tap((state) =>
          state.phase === "auth" && state.state.phase === "waiting"
            ? Deferred.succeed(waiting, state.state)
            : Effect.void,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const state = yield* Deferred.await(waiting);
      const url = new URL(state.authorizationUrl!);
      assert.strictEqual(url.searchParams.get("client_id"), profile!.clientId);
      assert.strictEqual(url.searchParams.get("id_token_hint"), profile!.idTokenHint);
      assert.strictEqual(url.searchParams.get("login_hint"), profile!.email);
      assert.strictEqual(url.searchParams.get("ext_agent_host_id"), `urn:uuid:${h.environmentId}`);
      yield* h.finishCallback(state);
      const results = yield* Fiber.join(resultFiber);
      assert.strictEqual(results.at(-1)?.phase, "finished");
    }),
  ),
);
it.effect(
  "cancelling primary handoff closes its callback listener without saving credentials",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const waiting = yield* Deferred.make<{ authorizationUrl: string | null }>();
        const flow = yield* h.handoff(null).pipe(
          Stream.tap((state) =>
            state.phase === "auth" && state.state.phase === "waiting"
              ? Deferred.succeed(waiting, state.state)
              : Effect.void,
          ),
          Stream.runDrain,
          Effect.forkChild,
        );
        const state = yield* Deferred.await(waiting);
        yield* Fiber.interrupt(flow);
        const callback = new URL(
          new URL(state.authorizationUrl!).searchParams.get("redirect_uri")!,
        );
        const request = yield* Effect.tryPromise(() => fetch(callback)).pipe(Effect.result);
        assert.strictEqual(request._tag, "Failure");
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);
it.effect("telemetry failures do not fail a verified ChatGPT sign-in", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarnessFor(instanceId, new Map(), true);
      yield* h.signIn;
      const state = yield* h.phase("succeeded");
      assert.strictEqual(state.phase, "succeeded");
      assert.isTrue(Option.isSome(yield* h.auth.read));
    }),
  ),
);
it.effect("a running session renews its bound profile but refuses a replacement sign-in", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      const profileKey = yield* h.auth.profileKey(Option.getOrThrow(yield* h.auth.read));
      const first = yield* h.bindProfile(profileKey);
      const second = yield* h.bindProfile(profileKey);
      yield* h.seedExpired;
      const renewed = yield* Effect.all([first.access, second.access], {
        concurrency: "unbounded",
      });
      assert.equal(h.refreshes(), 1);
      assert.equal(renewed[0].accessToken, "access-1");
      assert.deepEqual(renewed[0], renewed[1]);
      assert.equal(yield* h.auth.profileKey(renewed[0]), profileKey);

      // Reconnecting the same account replaces its sign-in identity, too.
      yield* h.reconnectProfile("oaiapp_test");
      yield* h.phase("succeeded");
      const replacement = Option.getOrThrow(yield* h.auth.read);
      assert.equal(replacement.clientId, renewed[0].clientId);
      assert.equal(replacement.subject, renewed[0].subject);
      yield* h.seedExpired;
      assert.equal((yield* first.access.pipe(Effect.flip)).operation, "access");
      assert.equal(h.refreshes(), 1);
      yield* h.auth.revoke;
      assert.equal((yield* second.access.pipe(Effect.flip)).operation, "access");
      assert.isTrue(Option.isNone(yield* h.auth.read));
    }),
  ),
);
