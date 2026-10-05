import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

// Billing-account-scoped: set GOOGLE_BILLING_ACCOUNT when the credentials
// administer the billing account (the testing service account does not).
const billingAccountId = process.env.GOOGLE_BILLING_ACCOUNT?.trim().replace(
  /^billingAccounts\//,
  "",
);
const account = billingAccountId ?? "";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Billing-account saved queries are rejected ("Billing account is not
// supported") unless the billing account is enabled for them. Set
// GCP_TEST_BILLING_SAVED_QUERY=1 on an entitled billing account.
const entitled = process.env.GCP_TEST_BILLING_SAVED_QUERY === "1";

const waitUntilGone = (name: string) =>
  logging.getBillingAccountsLocationsSavedQueries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!billingAccountId)(
  "getBillingAccountsLocationsSavedQueries on a missing query fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        logging.getBillingAccountsLocationsSavedQueries({
          name: `billingAccounts/${account}/locations/global/savedQueries/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

test.provider.skipIf(!billingAccountId || !entitled)(
  "create, update, replace, and delete a billing saved query",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSavedQuery("Errors", {
            billingAccountId: account,
            displayName: "billing errors",
            loggingQuery: { filter: "severity>=ERROR" },
            description: "error query",
          });
        }),
      );

      expect(created.savedQueryId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.billingAccountId).toEqual(account);
      expect(created.displayName).toEqual("billing errors");
      expect(created.loggingQuery?.filter).toEqual("severity>=ERROR");
      expect(created.description).toEqual("error query");

      const fetched = yield* logging.getBillingAccountsLocationsSavedQueries({
        name: created.name,
      });
      expect(fetched.displayName).toEqual("billing errors");
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSavedQuery("Errors", {
            billingAccountId: account,
            savedQueryId: created.savedQueryId,
            location: created.location,
            displayName: "billing warnings",
            loggingQuery: { filter: "severity>=WARNING" },
            description: "warning query",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("billing warnings");
      expect(updated.loggingQuery?.filter).toEqual("severity>=WARNING");

      const last = created.savedQueryId.at(-1) ?? "a";
      const nextId = `${created.savedQueryId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSavedQuery("Errors", {
            billingAccountId: account,
            savedQueryId: nextId,
            displayName: "replaced query",
            loggingQuery: { filter: "severity>=ERROR" },
            description: "replaced query",
          });
        }),
      );

      expect(replaced.savedQueryId).not.toEqual(created.savedQueryId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
