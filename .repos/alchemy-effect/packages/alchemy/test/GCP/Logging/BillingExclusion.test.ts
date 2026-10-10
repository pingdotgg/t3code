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

const waitUntilGone = (name: string) =>
  logging.getBillingAccountsExclusions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!billingAccountId)(
  "getBillingAccountsExclusions on a missing exclusion fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        logging.getBillingAccountsExclusions({
          name: `billingAccounts/${account}/exclusions/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

test.provider.skipIf(!billingAccountId)(
  "create, update, replace, and delete a billing exclusion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingExclusion("DropDebug", {
            billingAccountId: account,
            filter: "severity=DEBUG",
            description: "drop debug entries",
          });
        }),
      );

      expect(created.exclusionId).toEqual(expect.any(String));
      expect(created.billingAccountId).toEqual(account);
      expect(created.name).toEqual(
        `billingAccounts/${account}/exclusions/${created.exclusionId}`,
      );
      expect(created.filter).toEqual("severity=DEBUG");
      expect(created.description).toEqual("drop debug entries");
      expect(created.disabled).toEqual(false);

      const fetched = yield* logging.getBillingAccountsExclusions({
        name: created.name,
      });
      expect(fetched.filter).toEqual("severity=DEBUG");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("drop debug entries");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingExclusion("DropDebug", {
            billingAccountId: account,
            exclusionId: created.exclusionId,
            filter: "severity<ERROR",
            description: "drop non-errors",
            disabled: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.filter).toEqual("severity<ERROR");
      expect(updated.description).toEqual("drop non-errors");
      expect(updated.disabled).toEqual(true);

      const last = created.exclusionId.at(-1) ?? "a";
      const nextExclusionId = `${created.exclusionId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingExclusion("DropDebug", {
            billingAccountId: account,
            exclusionId: nextExclusionId,
            filter: "severity=DEBUG",
            description: "replaced exclusion",
          });
        }),
      );

      expect(replaced.exclusionId).not.toEqual(created.exclusionId);
      expect(replaced.description).toEqual("replaced exclusion");

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
