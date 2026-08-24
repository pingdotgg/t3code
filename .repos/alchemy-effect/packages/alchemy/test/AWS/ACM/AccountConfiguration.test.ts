import * as AWS from "@/AWS";
import { AccountConfiguration } from "@/AWS/ACM/AccountConfiguration.ts";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

// The AccountConfiguration provider pins its calls to us-east-1; every
// out-of-band ACM call in this file must target the same region.
const withUsEast1 = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

const { test } = Test.make({ providers: AWS.providers() });

const getDays = withUsEast1(
  acm
    .getAccountConfiguration({})
    .pipe(
      Effect.map((response) => response.ExpiryEvents?.DaysBeforeExpiry ?? 45),
    ),
);

// PutAccountConfiguration is heavily rate-limited and may report a typed
// ConflictException while a previous change settles — retry both, bounded.
const putDays = (days: number, tokenSeed: string) =>
  withUsEast1(
    acm
      .putAccountConfiguration({
        ExpiryEvents: { DaysBeforeExpiry: days },
        IdempotencyToken: `${tokenSeed}${days}`.slice(0, 32),
      })
      .pipe(
        Effect.retry({
          while: (e): boolean =>
            e._tag === "ConflictException" || e._tag === "ThrottlingException",
          schedule: Schedule.max([
            Schedule.exponential("1 second"),
            Schedule.recurs(8),
          ]),
        }),
      ),
  );

// Account-global singleton: capture the live threshold up front and restore
// it on scope close so the test leaves the account exactly as it found it,
// even if an assertion fails mid-way.
test.provider(
  "manages the account expiry-event threshold in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const originalDays = yield* getDays;
      yield* Effect.addFinalizer(() =>
        putDays(originalDays, "alchemyacmrestore").pipe(Effect.ignore),
      );

      // Create — converge the singleton onto a non-default threshold.
      const created = yield* stack.deploy(
        AccountConfiguration("ExpiryEvents", {
          daysBeforeExpiry: "30 days",
        }),
      );
      expect(created.daysBeforeExpiry).toBe(30);
      expect(yield* getDays).toBe(30);

      // Update in place — same singleton, new threshold (also proves the
      // provider issues a fresh idempotency token per desired value).
      const updated = yield* stack.deploy(
        AccountConfiguration("ExpiryEvents", {
          daysBeforeExpiry: "31 days",
        }),
      );
      expect(updated.daysBeforeExpiry).toBe(31);
      expect(yield* getDays).toBe(31);

      // Destroy — resets the threshold to the AWS account default.
      yield* stack.destroy();
      expect(yield* getDays).toBe(45);
    }),
  { timeout: 120_000 },
);
