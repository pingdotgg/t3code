import { ProfileStore, type ProviderConfig } from "@/Auth/Profile.ts";
import { LOCAL_ACCOUNT_ID, localAccountId } from "@/Cloudflare/LocalAccount.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const { test } = Test.make({ providers: Layer.empty });
const PROFILE_ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENV_ACCOUNT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

for (const [label, config] of Object.entries({
  token: {
    method: "stored",
    credentialType: "apiToken",
    apiToken: "unused",
    accountId: PROFILE_ACCOUNT,
  },
  expiredOAuth: {
    method: "oauth",
    access: "expired",
    refresh: "unused",
    expires: 0,
    scopes: [],
    accountId: PROFILE_ACCOUNT,
  },
} satisfies Record<string, ProviderConfig>)) {
  test(
    `local account uses the selected ${label} profile without authenticating`,
    Effect.gen(function* () {
      const profiles = yield* ProfileStore;
      const account = yield* localAccountId.pipe(
        Effect.provideService(ProfileStore, {
          ...profiles,
          current: Effect.succeed({
            name: "selected",
            source: "configuration" as const,
          }),
          getProfile: (name) => {
            expect(name).toBe("selected");
            return Effect.succeed({
              id: name,
              providers: { Cloudflare: config },
            });
          },
        }),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      );
      expect(account).toBe(PROFILE_ACCOUNT);
    }),
    { tags: ["unit", "local"] },
  );
}

test(
  "environment account takes precedence without credentials or a profile read",
  Effect.gen(function* () {
    // No auth or profile services supplied: neither is needed for an env ID.
    expect(
      yield* localAccountId.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ CLOUDFLARE_ACCOUNT_ID: ENV_ACCOUNT }),
          ),
        ),
      ),
    ).toBe(ENV_ACCOUNT);
  }),
  { tags: ["unit", "local"] },
);

test(
  "an unconfigured profile retains the credentialless fallback",
  Effect.gen(function* () {
    const profiles = yield* ProfileStore;
    expect(
      yield* localAccountId.pipe(
        Effect.provideService(ProfileStore, {
          ...profiles,
          getProfile: () => Effect.succeed(undefined),
        }),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      ),
    ).toBe(LOCAL_ACCOUNT_ID);
  }),
  { tags: ["unit", "local"] },
);
