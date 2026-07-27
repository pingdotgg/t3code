import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getProfile = (accountId: string, policyId: string) =>
  zeroTrust.getDevicePolicyCustom({ accountId, policyId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, policyId: string) =>
  getProfile(accountId, policyId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "ProfileNotDeleted" } as const)),
    // A missing profile surfaces as `DevicePolicyNotFound` (Cloudflare
    // error code 2052) — that's the success condition here.
    Effect.catchTag("DevicePolicyNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ProfileNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update in place, and delete a custom device profile",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const profile = yield* stack.deploy(
        Cloudflare.Devices.DeviceCustomProfile("Contractors", {
          name: "alchemy-test-custom-profile",
          match: 'identity.email == "contractor@alchemy-test-2.us"',
          precedence: 12010,
          description: "Alchemy test profile",
          switchLocked: true,
        }),
      );

      expect(profile.policyId).toBeTruthy();
      expect(profile.accountId).toEqual(accountId);
      expect(profile.name).toEqual("alchemy-test-custom-profile");
      expect(profile.match).toEqual(
        'identity.email == "contractor@alchemy-test-2.us"',
      );
      expect(profile.description).toEqual("Alchemy test profile");
      expect(profile.switchLocked).toEqual(true);
      expect(profile.default).toEqual(false);

      // Out-of-band verify against the live API.
      const live = yield* getProfile(accountId, profile.policyId);
      expect(live?.name).toEqual("alchemy-test-custom-profile");
      expect(live?.switchLocked).toEqual(true);

      // Update mutable props (body + split-tunnel exclude list) in place —
      // same policyId.
      const updated = yield* stack.deploy(
        Cloudflare.Devices.DeviceCustomProfile("Contractors", {
          name: "alchemy-test-custom-profile",
          match: 'identity.email == "contractor@alchemy-test-2.us"',
          precedence: 12010,
          description: "Alchemy test profile v2",
          switchLocked: false,
          exclude: [{ address: "10.99.0.0/16", description: "test range" }],
        }),
      );
      expect(updated.policyId).toEqual(profile.policyId);
      expect(updated.description).toEqual("Alchemy test profile v2");
      expect(updated.switchLocked).toEqual(false);
      expect(updated.exclude.some((e) => e.address === "10.99.0.0/16")).toEqual(
        true,
      );

      // Out-of-band verify the exclude list endpoint.
      const excludes = yield* zeroTrust
        .getDevicePolicyCustomExclude({
          accountId,
          policyId: profile.policyId,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: Schedule.exponential("500 millis"),
            times: 8,
          }),
        );
      expect(
        (excludes.result ?? []).some(
          (e) => "address" in e && e.address === "10.99.0.0/16",
        ),
      ).toEqual(true);

      yield* stack.destroy();
      yield* expectGone(accountId, profile.policyId);
    }).pipe(logLevel),
);

test.provider("list enumerates the deployed custom device profile", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Cloudflare.Devices.DeviceCustomProfile("ListProfile", {
        name: "alchemy-test-custom-profile-list",
        match: 'identity.email == "list@alchemy-test-2.us"',
        precedence: 12011,
        description: "Alchemy list() test profile",
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Devices.DeviceCustomProfile,
    );
    const all = yield* provider.list();

    // Exhaustively paginated account collection must contain the profile we
    // just deployed, hydrated into the exact `read` Attributes shape.
    const found = all.find((p) => p.policyId === deployed.policyId);
    expect(found).toBeDefined();
    expect(found?.name).toEqual("alchemy-test-custom-profile-list");
    expect(found?.match).toEqual('identity.email == "list@alchemy-test-2.us"');
    expect(found?.accountId).toEqual(deployed.accountId);
    expect(found?.default).toEqual(false);

    yield* stack.destroy();
  }).pipe(logLevel),
);
