import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetAppsSecretsFind } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { isMissingStripeResource } from "@/Stripe/missing.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const ACCOUNT_SCOPE = { type: "account" as const };

const LIFECYCLE_NAME = "alchemy-apps-secret-lifecycle";
const LIST_NAME = "alchemy-apps-secret-list";
const REPLACE_FROM_NAME = "alchemy-apps-secret-replace-a";
const REPLACE_TO_NAME = "alchemy-apps-secret-replace-b";

const LIFECYCLE_PAYLOAD = "alchemy-apps-secret-payload";
const LIFECYCLE_PAYLOAD_ROTATED = "alchemy-apps-secret-payload-rotated";
const LIST_PAYLOAD = "alchemy-apps-secret-list-payload";
const REPLACE_PAYLOAD = "alchemy-apps-secret-replace-payload";

const EXPIRES_AT = 2_000_000_000;
const EXPIRES_AT_UPDATED = 2_100_000_000;

const waitUntilGone = (name: string) =>
  GetAppsSecretsFind({ name, scope: ACCOUNT_SCOPE }).pipe(
    Effect.map((secret) =>
      secret.deleted === true ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchIf(isMissingStripeResource, () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an apps secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.AppsSecret("LifecycleSecret", {
            name: LIFECYCLE_NAME,
            payload: LIFECYCLE_PAYLOAD,
            scope: ACCOUNT_SCOPE,
            expiresAt: EXPIRES_AT,
          });
        }),
      );

      expect(created.id).toMatch(/^(appsecret_|secret_)/);
      expect(created.name).toEqual(LIFECYCLE_NAME);
      expect(created.scope).toEqual(ACCOUNT_SCOPE);
      expect(created.expiresAt).toEqual(EXPIRES_AT);
      expect(created.livemode).toEqual(false);
      expect(created.created).toEqual(expect.any(Number));

      const fetched = yield* GetAppsSecretsFind({
        name: LIFECYCLE_NAME,
        scope: ACCOUNT_SCOPE,
        expand: ["payload"],
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toEqual(LIFECYCLE_NAME);
      expect(fetched.scope.type).toEqual("account");
      expect(fetched.expires_at).toEqual(EXPIRES_AT);
      if (fetched.payload != null) {
        expect(fetched.payload).toEqual(LIFECYCLE_PAYLOAD);
      }

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.AppsSecret("LifecycleSecret", {
            name: LIFECYCLE_NAME,
            payload: LIFECYCLE_PAYLOAD_ROTATED,
            scope: ACCOUNT_SCOPE,
            expiresAt: EXPIRES_AT_UPDATED,
          });
        }),
      );

      expect(updated.name).toEqual(LIFECYCLE_NAME);
      expect(updated.scope).toEqual(ACCOUNT_SCOPE);
      expect(updated.expiresAt).toEqual(EXPIRES_AT_UPDATED);

      const refetched = yield* GetAppsSecretsFind({
        name: LIFECYCLE_NAME,
        scope: ACCOUNT_SCOPE,
        expand: ["payload"],
      });
      expect(refetched.name).toEqual(LIFECYCLE_NAME);
      expect(refetched.expires_at).toEqual(EXPIRES_AT_UPDATED);
      if (refetched.payload != null) {
        expect(refetched.payload).toEqual(LIFECYCLE_PAYLOAD_ROTATED);
      }

      yield* stack.destroy();

      const gone = yield* waitUntilGone(LIFECYCLE_NAME);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when the name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.AppsSecret("ReplaceSecret", {
            name: REPLACE_FROM_NAME,
            payload: REPLACE_PAYLOAD,
            scope: ACCOUNT_SCOPE,
          });
        }),
      );

      expect(created.name).toEqual(REPLACE_FROM_NAME);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.AppsSecret("ReplaceSecret", {
            name: REPLACE_TO_NAME,
            payload: REPLACE_PAYLOAD,
            scope: ACCOUNT_SCOPE,
          });
        }),
      );

      expect(replaced.name).toEqual(REPLACE_TO_NAME);
      expect(replaced.id).not.toEqual(created.id);

      const fetched = yield* GetAppsSecretsFind({
        name: REPLACE_TO_NAME,
        scope: ACCOUNT_SCOPE,
      });
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.name).toEqual(REPLACE_TO_NAME);

      const oldGone = yield* waitUntilGone(REPLACE_FROM_NAME);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(REPLACE_TO_NAME);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed apps secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.AppsSecret("ListSecret", {
            name: LIST_NAME,
            payload: LIST_PAYLOAD,
            scope: ACCOUNT_SCOPE,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.AppsSecret);
      const all = yield* provider.list();
      const found = all.find((secret) => secret.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(LIST_NAME);
      expect(found?.scope).toEqual(ACCOUNT_SCOPE);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(LIST_NAME);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
