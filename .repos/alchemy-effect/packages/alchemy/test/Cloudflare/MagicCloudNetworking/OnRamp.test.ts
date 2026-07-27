import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as mcn from "@distilled.cloud/cloudflare/magic-cloud-networking";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Magic Cloud Networking is an entitlement-gated add-on (Magic WAN family).
// On the standard testing account every MCN call fails with the typed
// `FeatureNotEnabled` error (HTTP 403, Cloudflare code 1012 "feature not
// enabled"). On-ramps additionally provision real cloud-side infrastructure
// (VPN gateways / Transit Gateways) inside a wired CloudIntegration, so the
// lifecycle test needs an entitled account AND a discovered VPC, supplied
// via env. The probe test always runs and pins the typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_CLOUD_NETWORKING;
// Discovered VPC resource id + region to connect (entitled accounts only).
const vpcId = process.env.CLOUDFLARE_TEST_MCN_VPC_ID;
const vpcRegion = process.env.CLOUDFLARE_TEST_MCN_VPC_REGION;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band calls. The retry
// is bounded so an unentitled account fails fast with the typed tag.
const getOnRamp = (accountId: string, onrampId: string) =>
  mcn.getOnRamp({ accountId, onrampId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 5,
    }),
  );

// Poll until the on-ramp is gone after destroy. Cloudflare answers GET for
// a missing on-ramp with the typed `OnRampNotFound` (404). Deletion tears
// down cloud-side infra, so the window is generous but bounded.
const expectGone = (accountId: string, onrampId: string) =>
  getOnRamp(accountId, onrampId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "OnRampNotDeleted" } as const)),
    Effect.catchTag("OnRampNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "OnRampNotDeleted",
      schedule: Schedule.spaced("5 seconds"),
      times: 10,
    }),
  );

test.provider(
  "unentitled accounts surface the typed FeatureNotEnabled error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const canList = yield* mcn.listOnRamps({ accountId }).pipe(
        Effect.as(true),
        Effect.catchTag("FeatureNotEnabled", () => Effect.succeed(false)),
      );
      if (canList) {
        // Entitled account — the gated lifecycle test covers real behavior.
        yield* Effect.logInfo("account is MCN-entitled; probe test is a no-op");
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* mcn.listOnRamps({ accountId }).pipe(Effect.flip);
      expect(error._tag).toEqual("FeatureNotEnabled");

      const createError = yield* mcn
        .createOnRamp({
          accountId,
          name: "alchemy-mcn-probe",
          cloudType: "AWS",
          type: "OnrampTypeSingle",
          dynamicRouting: false,
          installRoutesInCloud: false,
          installRoutesInMagicWan: false,
        })
        .pipe(Effect.flip);
      expect(createError._tag).toEqual("FeatureNotEnabled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!entitled || !vpcId || !vpcRegion)(
  "creates an on-ramp, updates mutable props in place, and destroys it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const onramp = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.OnRamp("Ramp", {
          name: "alchemy-mcn-onramp",
          cloudType: "AWS",
          type: "OnrampTypeSingle",
          region: vpcRegion!,
          vpc: vpcId!,
          dynamicRouting: false,
          installRoutesInCloud: false,
          installRoutesInMagicWan: false,
          description: "alchemy on-ramp test",
        }),
      );

      expect(onramp.onRampId).toBeDefined();
      expect(onramp.accountId).toEqual(accountId);
      expect(onramp.name).toEqual("alchemy-mcn-onramp");
      expect(onramp.cloudType).toEqual("AWS");
      expect(onramp.type).toEqual("OnrampTypeSingle");

      // Out-of-band verification via the distilled API.
      const live = yield* getOnRamp(accountId, onramp.onRampId);
      expect(live.name).toEqual("alchemy-mcn-onramp");

      // Update mutable props in place — same onRampId.
      const updated = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.OnRamp("Ramp", {
          name: "alchemy-mcn-onramp-v2",
          cloudType: "AWS",
          type: "OnrampTypeSingle",
          region: vpcRegion!,
          vpc: vpcId!,
          dynamicRouting: false,
          installRoutesInCloud: false,
          installRoutesInMagicWan: true,
          description: "alchemy on-ramp test v2",
        }),
      );

      expect(updated.onRampId).toEqual(onramp.onRampId);
      expect(updated.name).toEqual("alchemy-mcn-onramp-v2");
      expect(updated.installRoutesInMagicWan).toBe(true);
      expect(updated.description).toEqual("alchemy on-ramp test v2");

      yield* stack.destroy();

      yield* expectGone(accountId, onramp.onRampId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Read-only list assertion that runs on every account. On an unentitled
// account `list()` catches the typed `FeatureNotEnabled` and returns a
// well-typed `[]`; on an entitled account it returns the account's on-ramps
// as the exact `read` Attributes shape (an array, possibly empty).
test.provider("list returns on-ramps or a typed [] when unentitled", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const canList = yield* mcn.listOnRamps({ accountId }).pipe(
      Effect.as(true),
      Effect.catchTag("FeatureNotEnabled", () => Effect.succeed(false)),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.MagicCloudNetworking.OnRamp,
    );
    const all = yield* provider.list();

    if (!canList) {
      // Unentitled — FeatureNotEnabled makes the account non-listable.
      expect(all).toEqual([]);
    } else {
      expect(Array.isArray(all)).toBe(true);
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider.skipIf(!entitled || !vpcId || !vpcRegion)(
  "list enumerates the deployed on-ramp",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const onramp = yield* stack.deploy(
        Cloudflare.MagicCloudNetworking.OnRamp("ListRamp", {
          name: "alchemy-mcn-list-onramp",
          cloudType: "AWS",
          type: "OnrampTypeSingle",
          region: vpcRegion!,
          vpc: vpcId!,
          dynamicRouting: false,
          installRoutesInCloud: false,
          installRoutesInMagicWan: false,
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicCloudNetworking.OnRamp,
      );
      const all = yield* provider.list();

      expect(all.some((x) => x.onRampId === onramp.onRampId)).toBe(true);
      expect(all.some((x) => x.name === "alchemy-mcn-list-onramp")).toBe(true);

      yield* stack.destroy();

      yield* expectGone(accountId, onramp.onRampId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
