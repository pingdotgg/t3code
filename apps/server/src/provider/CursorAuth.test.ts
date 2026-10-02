import type { SdkLoginOptions, StoredSdkCredentials } from "@cursor/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSetupError, type ProviderAuthState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeCursorAuth, type CursorAuthOptions } from "./CursorAuth.ts";
import { InMemoryCredentialStore } from "./cursorSdk.ts";

const instanceId = ProviderInstanceId.make("cursor-personal");
const owner = "owner-client";
const otherOwner = "other-client";
const authorizationUrl = "https://cursor.com/loginDeepControl?challenge=test-challenge";

const makeHarness = Effect.fn("makeCursorAuthHarness")(function* (
  overrides: Partial<CursorAuthOptions> = {},
) {
  const store = new InMemoryCredentialStore();
  const complete = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const now = yield* Clock.currentTimeMillis;
  const credentials: StoredSdkCredentials = {
    version: 1,
    backendUrl: "https://api2.cursor.sh",
    apiKey: "browser-key",
    createdAtMs: now,
    apiKeyExpiresAtMs: now + 86_400_000,
    email: "cursor@example.com",
  };
  let loginOptions: SdkLoginOptions | undefined;
  const changes: boolean[] = [];
  const auth = yield* makeCursorAuth({
    instanceId,
    displayName: "Personal Cursor",
    enabled: true,
    store,
    onChanged: (signedIn) =>
      Effect.sync(() => {
        changes.push(signedIn);
      }),
    login: async (options) => {
      loginOptions = options;
      options.onLoginUrl?.(authorizationUrl);
      await complete.promise;
      await options.store?.save(credentials);
      returned.resolve();
      return {
        apiKey: credentials.apiKey,
        apiKeyExpiresAtMs: credentials.apiKeyExpiresAtMs!,
        email: credentials.email!,
      };
    },
    ...overrides,
  });
  return {
    auth,
    store,
    complete,
    returned,
    credentials,
    changes,
    loginOptions: () => loginOptions,
  };
});

type Auth = Effect.Success<ReturnType<typeof makeCursorAuth>>;
const phase = (auth: Auth, phase: ProviderAuthState["phase"], session = owner) =>
  auth.controller.subscribe(session).pipe(
    Stream.filter((state) => state.phase === phase),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.layer(NodeServices.layer)("CursorAuth", (it) => {
  it.effect("closes SDK sessions and interrupts in-flight credential work before signing out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.promise(() => harness.store.save(harness.credentials));
      const acquired = yield* Deferred.make<void>();
      let closedSession = false;
      let closedRequest = false;
      yield* harness.auth.withAccess(
        Effect.acquireRelease(Effect.succeed("session"), () =>
          Effect.sync(() => {
            closedSession = true;
          }),
        ),
      );
      const request = yield* harness.auth
        .withAccess(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closedRequest = true;
              }),
            );
            yield* Deferred.succeed(acquired, undefined);
            return yield* Effect.never;
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(acquired);
      yield* harness.auth.controller.logout(Effect.void);
      expect(closedSession).toBe(true);
      expect(closedRequest).toBe(true);
      expect(Exit.isFailure(yield* Fiber.await(request))).toBe(true);
      expect(yield* harness.auth.readApiKey).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("completes a remote browser login, saves its key and refreshes provider status", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      let stopped = false;
      expect(yield* harness.auth.readApiKey).toBeUndefined();
      const starting = yield* harness.auth.controller.start(
        owner,
        Effect.sync(() => {
          stopped = true;
        }),
      );
      const waiting = yield* phase(harness.auth, "waiting");
      expect(stopped).toBe(true);
      expect(waiting.authorizationUrl).toBe(authorizationUrl);
      expect(waiting.flowId).toBe(starting.flowId);
      expect(harness.loginOptions()?.openBrowser).toBe(false);
      expect((yield* harness.auth.controller.start(owner)).flowId).toBe(starting.flowId);
      expect(Exit.isFailure(yield* Effect.exit(harness.auth.requireApiKey))).toBe(true);
      yield* Effect.sync(() => harness.complete.resolve());
      const succeeded = yield* phase(harness.auth, "succeeded");
      expect(succeeded.authorizationUrl).toBeNull();
      expect(yield* harness.auth.requireApiKey).toBe("browser-key");
      expect(harness.changes).toEqual([true]);
      expect(Object.values(succeeded)).not.toContain("browser-key");
      expect(yield* Effect.promise(() => harness.store.load())).toEqual(harness.credentials);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the login link private to its owner and rejects other clients' mutations", () =>
    Effect.gen(function* () {
      const { auth } = yield* makeHarness();
      yield* auth.controller.start(owner);
      const waiting = yield* phase(auth, "waiting");
      const foreign = yield* phase(auth, "waiting", otherOwner);
      expect(foreign).toMatchObject({ flowId: null, authorizationUrl: null, expiresAt: null });
      expect(Exit.isFailure(yield* Effect.exit(auth.controller.start(otherOwner)))).toBe(true);
      expect(
        Exit.isFailure(yield* Effect.exit(auth.controller.cancel(otherOwner, waiting.flowId!))),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            auth.controller.complete(owner, {
              flowId: waiting.flowId!,
              callbackUrl: "http://localhost/callback",
            }),
          ),
        ),
      ).toBe(true);
      expect((yield* phase(auth, "waiting")).authorizationUrl).toBe(authorizationUrl);
    }).pipe(Effect.scoped),
  );

  it.effect("aborts cancellation and ignores a late successful SDK login", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auth.controller.start(owner);
      const waiting = yield* phase(harness.auth, "waiting");
      const cancelled = yield* harness.auth.controller.cancel(owner, waiting.flowId!);
      expect(cancelled.phase).toBe("cancelled");
      expect(cancelled.authorizationUrl).toBeNull();
      expect(harness.loginOptions()?.signal?.aborted).toBe(true);
      yield* Effect.sync(() => harness.complete.resolve());
      yield* Effect.promise(() => harness.returned.promise);
      expect(yield* harness.auth.readApiKey).toBeUndefined();
      expect(harness.changes).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("times out pending logins and permits a retry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auth.controller.start(owner);
      const waiting = yield* phase(harness.auth, "waiting");
      yield* TestClock.adjust(300_000);
      expect((yield* phase(harness.auth, "failed")).authorizationUrl).toBeNull();
      expect(harness.loginOptions()?.signal?.aborted).toBe(true);
      const retry = yield* harness.auth.controller.start(owner);
      expect(retry.flowId).not.toBe(waiting.flowId);
    }).pipe(Effect.scoped),
  );

  it.effect("finishes saving a completed login atomically across the timeout", () =>
    Effect.gen(function* () {
      const store = new InMemoryCredentialStore();
      const saving = Promise.withResolvers<void>();
      const finishSave = Promise.withResolvers<void>();
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const harness = yield* makeHarness({
        store: {
          load: () => store.load(),
          clear: () => store.clear(),
          save: async (credentials) => {
            saving.resolve();
            await finishSave.promise;
            await store.save(credentials);
          },
        },
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* Effect.addFinalizer(() => Effect.sync(() => finishSave.resolve()));
      yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      yield* Effect.sync(() => harness.complete.resolve());
      yield* Effect.promise(() => saving.promise);
      yield* TestClock.adjust(300_000);
      yield* Effect.sync(() => finishSave.resolve());
      yield* phase(harness.auth, "succeeded");
      expect(yield* harness.auth.requireApiKey).toBe("browser-key");
      yield* Scope.close(scope, Exit.void);
      const state = yield* harness.auth.controller.subscribe(owner).pipe(Stream.runHead);
      expect(Option.getOrThrow(state).phase).toBe("succeeded");
      expect(harness.changes).toEqual([true]);
    }).pipe(Effect.scoped),
  );

  it.effect("discards a credential rejected by verification and permits a fresh login", () =>
    Effect.gen(function* () {
      let rejected = true;
      const harness = yield* makeHarness({
        onChanged: (signedIn) =>
          signedIn && rejected
            ? Effect.fail(
                new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: "Could not verify the Cursor sign-in.",
                }),
              )
            : Effect.void,
      });
      yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      yield* Effect.sync(() => harness.complete.resolve());
      yield* phase(harness.auth, "failed");
      expect(yield* Effect.promise(() => harness.store.load())).toBeUndefined();
      expect(yield* harness.auth.readApiKey).toBeUndefined();
      expect(Exit.isFailure(yield* Effect.exit(harness.auth.requireApiKey))).toBe(true);
      rejected = false;
      yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "succeeded");
      expect(yield* harness.auth.requireApiKey).toBe("browser-key");
    }).pipe(Effect.scoped),
  );

  it.effect("clears only this instance's credential after its sessions stop", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const other = yield* makeHarness({ instanceId: ProviderInstanceId.make("cursor-work") });
      yield* Effect.promise(() => harness.store.save(harness.credentials));
      yield* Effect.promise(() => other.store.save({ ...other.credentials, apiKey: "other-key" }));
      const state = yield* harness.auth.controller.logout(
        Effect.gen(function* () {
          expect(yield* harness.auth.readApiKey).toBe("browser-key");
          expect(Exit.isFailure(yield* Effect.exit(harness.auth.requireApiKey))).toBe(true);
        }),
      );
      expect(state.message).toBe("Signed out of Cursor.");
      expect(yield* harness.auth.readApiKey).toBeUndefined();
      expect(yield* other.auth.requireApiKey).toBe("other-key");
      expect(harness.changes).toEqual([false]);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels a pending sign-in on logout without saving its eventual key", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      yield* harness.auth.controller.logout(Effect.void);
      expect(harness.loginOptions()?.signal?.aborted).toBe(true);
      yield* Effect.sync(() => harness.complete.resolve());
      yield* Effect.promise(() => harness.returned.promise);
      expect(yield* harness.auth.readApiKey).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("retains credentials if sessions cannot be stopped for logout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.promise(() => harness.store.save(harness.credentials));
      const result = yield* Effect.exit(
        harness.auth.controller.logout(
          Effect.fail(
            new ProviderSetupError({
              instanceId,
              operation: "stop",
              detail: "Unable to stop sessions",
            }),
          ),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* harness.auth.requireApiKey).toBe("browser-key");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "prefers explicit API keys and prevents browser login from silently overriding them",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ apiKey: " explicit-key " });
        yield* Effect.promise(() => harness.store.save(harness.credentials));
        expect(yield* harness.auth.requireApiKey).toBe("explicit-key");
        expect(Exit.isFailure(yield* Effect.exit(harness.auth.controller.start(owner)))).toBe(true);
        expect(
          Exit.isFailure(yield* Effect.exit(harness.auth.controller.logout(Effect.void))),
        ).toBe(true);
        expect(harness.loginOptions()).toBeUndefined();
        expect((yield* Effect.promise(() => harness.store.load()))?.apiKey).toBe("browser-key");
      }).pipe(Effect.scoped),
  );

  it.effect("ignores expired browser credentials and rejects disabled sign-in", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });
      yield* Effect.promise(() =>
        harness.store.save({ ...harness.credentials, apiKeyExpiresAtMs: 0 }),
      );
      expect(yield* harness.auth.readApiKey).toBeUndefined();
      expect(Exit.isFailure(yield* Effect.exit(harness.auth.controller.start(owner)))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("aborts pending login when the provider instance is disposed", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
      yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      yield* Scope.close(scope, Exit.void);
      expect(harness.loginOptions()?.signal?.aborted).toBe(true);
      yield* Effect.sync(() => harness.complete.resolve());
      yield* Effect.promise(() => harness.returned.promise);
      expect(yield* harness.auth.readApiKey).toBeUndefined();
    }),
  );
});
