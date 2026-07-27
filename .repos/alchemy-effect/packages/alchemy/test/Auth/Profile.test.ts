import {
  AuthError,
  AuthProviderLayer,
  AuthProviders,
  getAuthProvider,
} from "@/Auth/AuthProvider.ts";
import { AlchemyProfile, ProfileLive } from "@/Auth/Profile.ts";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { v4 as uuidv4 } from "uuid";

const FAKE_PROVIDER = "FakeAuthProvider";

// Records whether the lock-wrapped `configure` was ever entered. The
// non-interactive bail in `loadOrConfigure` must short-circuit *before* this
// runs — otherwise it would acquire an auth lockfile (which we must avoid for
// single-use OAuth refresh tokens).
const state = { configureCalls: 0 };

const FakeAuth = AuthProviderLayer<{ method: "env" }, undefined>()(
  FAKE_PROVIDER,
  {
    configure: () =>
      Effect.sync(() => {
        state.configureCalls += 1;
        return { method: "env" as const };
      }),
    login: () => Effect.void,
    logout: () => Effect.void,
    prettyPrint: () => Effect.void,
    read: () => Effect.succeed(undefined),
  },
);

const TestLayer = Layer.mergeAll(ProfileLive, FakeAuth).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      NodeServices.layer,
    ),
  ),
);

it.live(
  "loadOrConfigure bails (without configuring) for a missing profile when non-interactive",
  () =>
    Effect.gen(function* () {
      state.configureCalls = 0;
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<{ method: "env" }, undefined>(
        FAKE_PROVIDER,
      );

      const error = yield* profile
        .loadOrConfigure(auth, `non-existent-${uuidv4()}`, { ci: false })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).message).toContain("non-interactive");
      // The lock-wrapped `configure` must never run, so no lockfile is created.
      expect(state.configureCalls).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
);
