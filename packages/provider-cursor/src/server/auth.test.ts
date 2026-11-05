import type { SdkLoginOptions, StoredSdkCredentials } from "@cursor/sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSetupError, type ProviderAuthState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeCursorAuth, type CursorAuthOptions } from "./auth.ts";
import type { CursorTeam } from "./auth.ts";
import { loadCursorSdk } from "./sdk.ts";

const { InMemoryCredentialStore } = loadCursorSdk();

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
const readApiKey = (auth: Auth) => Effect.map(auth.readAccess, (access) => access?.apiKey);
const requireApiKey = (auth: Auth) => Effect.map(auth.requireAccess, (access) => access.apiKey);
const phase = (auth: Auth, phase: ProviderAuthState["phase"], session = owner) =>
  auth.controller.subscribe(session).pipe(
    Stream.filter((state) => state.phase === phase),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("CursorAuth", (it) => {
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
      expect(yield* readApiKey(harness.auth)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("completes a remote browser login, saves its key and refreshes provider status", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      let stopped = false;
      expect(yield* readApiKey(harness.auth)).toBeUndefined();
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
      expect(Exit.isFailure(yield* Effect.exit(requireApiKey(harness.auth)))).toBe(true);
      yield* Effect.sync(() => harness.complete.resolve());
      const succeeded = yield* phase(harness.auth, "succeeded");
      expect(succeeded.authorizationUrl).toBeNull();
      expect(yield* requireApiKey(harness.auth)).toBe("browser-key");
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
      expect(yield* readApiKey(harness.auth)).toBeUndefined();
      expect(harness.changes).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("discards a credential rejected by verification and permits a fresh login", () =>
    Effect.gen(function* () {
      const rejectionMessage =
        "Cursor needs a paid plan to run in T3 Code. Upgrade this account or sign in with a different one.";
      let rejected = true;
      const harness = yield* makeHarness({
        onChanged: (signedIn) =>
          signedIn && rejected
            ? Effect.fail(
                new ProviderSetupError({
                  instanceId,
                  operation: "start",
                  detail: rejectionMessage,
                }),
              )
            : Effect.void,
      });
      yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "waiting");
      yield* Effect.sync(() => harness.complete.resolve());
      const failed = yield* phase(harness.auth, "failed");
      expect(failed.message).toBe(rejectionMessage);
      expect(yield* Effect.promise(() => harness.store.load())).toBeUndefined();
      expect(yield* readApiKey(harness.auth)).toBeUndefined();
      expect(Exit.isFailure(yield* Effect.exit(requireApiKey(harness.auth)))).toBe(true);
      rejected = false;
      yield* harness.auth.controller.start(owner);
      yield* phase(harness.auth, "succeeded");
      expect(yield* requireApiKey(harness.auth)).toBe("browser-key");
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
          expect(yield* readApiKey(harness.auth)).toBe("browser-key");
          expect(Exit.isFailure(yield* Effect.exit(requireApiKey(harness.auth)))).toBe(true);
        }),
      );
      expect(state.message).toBe("Signed out of Cursor.");
      expect(yield* readApiKey(harness.auth)).toBeUndefined();
      expect(yield* requireApiKey(other.auth)).toBe("other-key");
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
      expect(yield* readApiKey(harness.auth)).toBeUndefined();
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
      expect(yield* requireApiKey(harness.auth)).toBe("browser-key");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "prefers explicit API keys and prevents browser login from silently overriding them",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ apiKey: " explicit-key " });
        yield* Effect.promise(() => harness.store.save(harness.credentials));
        expect(yield* requireApiKey(harness.auth)).toBe("explicit-key");
        expect(Exit.isFailure(yield* Effect.exit(harness.auth.controller.start(owner)))).toBe(true);
        expect(
          Exit.isFailure(yield* Effect.exit(harness.auth.controller.logout(Effect.void))),
        ).toBe(true);
        expect(harness.loginOptions()).toBeUndefined();
        expect((yield* Effect.promise(() => harness.store.load()))?.apiKey).toBe("browser-key");
      }).pipe(Effect.scoped),
  );

  it.effect.each<{
    name: string;
    apiKey?: string;
    teamId?: string;
    expected?: CursorTeam | "rejected";
  }>([
    { name: "the default team for browser sign-in" },
    {
      name: "CURSOR_TEAM_ID for browser sign-in",
      teamId: " 42 ",
      expected: { id: 42, name: undefined },
    },
    ...["abc", "0", "-1", "1.5", "1e3", "2147483648", "9007199254740993"].map((teamId) => ({
      name: `no team for an invalid CURSOR_TEAM_ID "${teamId}"`,
      teamId,
      expected: "rejected" as const,
    })),
    { name: "the default team for an explicit API key", apiKey: "explicit-key" },
    {
      name: "CURSOR_TEAM_ID for an explicit API key",
      apiKey: "explicit-key",
      teamId: "42",
      expected: { id: 42, name: undefined },
    },
  ])("uses $name", ({ apiKey, teamId, expected }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ...(apiKey ? { apiKey } : {}),
        ...(teamId ? { teamId } : {}),
      });
      yield* Effect.promise(() => harness.store.save(harness.credentials));
      const access = yield* Effect.exit(harness.auth.requireAccess);
      if (expected === "rejected") expect(Exit.isFailure(access)).toBe(true);
      else expect(Exit.isSuccess(access) && access.value.team).toEqual(expected);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores expired browser credentials and rejects disabled sign-in", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });
      yield* Effect.promise(() =>
        harness.store.save({ ...harness.credentials, apiKeyExpiresAtMs: 0 }),
      );
      expect(yield* readApiKey(harness.auth)).toBeUndefined();
      expect(Exit.isFailure(yield* Effect.exit(harness.auth.controller.start(owner)))).toBe(true);
    }).pipe(Effect.scoped),
  );
});
