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
  logging.getBillingAccountsSinks({ sinkName: name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!billingAccountId)(
  "getBillingAccountsSinks on a missing sink fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        logging.getBillingAccountsSinks({
          sinkName: `billingAccounts/${account}/sinks/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

test.provider.skipIf(!billingAccountId)(
  "create, update, replace, and delete a billing sink",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const destination = `logging.googleapis.com/billingAccounts/${account}/locations/global/buckets/_Default`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSink("Errors", {
            billingAccountId: account,
            destination,
            filter: "severity>=ERROR",
            description: "application errors",
          });
        }),
      );

      expect(created.sinkId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `billingAccounts/${account}/sinks/${created.sinkId}`,
      );
      expect(created.destination).toEqual(destination);
      expect(created.filter).toEqual("severity>=ERROR");
      expect(created.description).toEqual("application errors");

      const fetched = yield* logging.getBillingAccountsSinks({
        sinkName: created.name,
      });
      expect(fetched.destination).toEqual(destination);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSink("Errors", {
            billingAccountId: account,
            sinkId: created.sinkId,
            destination,
            filter: "severity>=WARNING",
            description: "warnings and errors",
            disabled: true,
          });
        }),
      );

      expect(updated.filter).toEqual("severity>=WARNING");
      expect(updated.disabled).toEqual(true);

      const last = created.sinkId.at(-1) ?? "a";
      const nextSinkId = `${created.sinkId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSink("Errors", {
            billingAccountId: account,
            sinkId: nextSinkId,
            destination,
            filter: "severity>=WARNING",
            description: "replaced sink",
          });
        }),
      );

      expect(replaced.sinkId).not.toEqual(created.sinkId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
