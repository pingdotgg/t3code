import * as AWS from "@/AWS";
import { Region } from "@/AWS/Region.ts";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import IoTMITestFunctionLive, { IoTMITestFunction } from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);

// IoT Managed Integrations is only deployed in a few regions (eu-west-1,
// ca-central-1, ...). The testing profile's default region (us-west-2) has no
// endpoint, so the ungated probes pin a supported region explicitly. The
// gated fixture below requires an AWS profile whose region IS a supported
// one, e.g. a profile with region = eu-west-1.
const MI_REGION = "eu-west-1";
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(MI_REGION)));

// ---------------------------------------------------------------------------
// Ungated typed-error probes: the operations the runtime bindings wrap are
// exercised directly through distilled and must answer with typed tags (or
// succeed, for the public schema catalog). These prove the distilled error
// unions and request serialization at near-zero cost on every CI pass; the
// full Lambda fixture is gated on a supported-region profile.
// ---------------------------------------------------------------------------

describe("IoTManagedIntegrations binding operations (typed probes)", () => {
  test.provider(
    "getManagedThingState on a nonexistent thing fails with a typed tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          pin(
            mi.getManagedThingState({
              ManagedThingId: "alchemynonexistentthingprobe",
            }),
          ),
        );
        expect(["ResourceNotFoundException", "ValidationException"]).toContain(
          error._tag,
        );
      }),
  );

  test.provider(
    "getDeviceDiscovery on a nonexistent discovery fails with a typed tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          pin(
            mi.getDeviceDiscovery({
              Identifier: "alchemynonexistentdiscoveryprobe",
            }),
          ),
        );
        expect(["ResourceNotFoundException", "ValidationException"]).toContain(
          error._tag,
        );
      }),
  );

  test.provider(
    "sendConnectorEvent to a nonexistent connector fails with a typed tag",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          pin(
            mi.sendConnectorEvent({
              ConnectorId: "alchemynonexistentconnectorprobe",
              Operation: "DEVICE_EVENT",
            }),
          ),
        );
        expect(["ResourceNotFoundException", "ValidationException"]).toContain(
          error._tag,
        );
      }),
  );

  test.provider(
    "listSchemaVersions reads the public capability schema catalog",
    () =>
      Effect.gen(function* () {
        const result = yield* pin(
          mi.listSchemaVersions({ Type: "capability", MaxResults: 3 }),
        );
        expect(result.Items).toBeDefined();
        expect(result.Items!.length).toBeGreaterThan(0);
      }),
  );
});

// ---------------------------------------------------------------------------
// Full runtime fixture: a Lambda bound to all 14 runtime bindings against a
// live credential locker + (unprovisioned) managed thing. Gated behind
// AWS_TEST_IOT_MI=1 with an AWS profile configured in a supported region
// (same gate as the resource lifecycle tests).
// ---------------------------------------------------------------------------

const sharedStack = Core.scratchStack(testOptions, "IoTMIBindings");

test.provider.skipIf(!process.env.AWS_TEST_IOT_MI)(
  "runtime bindings against a live managed thing",
  () =>
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* IoTMITestFunction;
          }).pipe(Effect.provide(IoTMITestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        const getJson = (path: string) =>
          HttpClient.get(`${baseUrl}${path}`).pipe(
            Effect.flatMap((response) =>
              response.status >= 500
                ? Effect.fail(
                    new Error(`transient upstream ${response.status}`),
                  )
                : Effect.succeed(response),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((r) => r.json),
          );

        // All 15 capabilities initialized in the runtime.
        const bindings = (yield* getJson("/bindings")) as { bound: string[] };
        expect(bindings.bound).toHaveLength(15);

        // Account-level ops must be authorized (Resource "*") and succeed.
        const schemas = (yield* getJson("/schema-versions")) as {
          count?: number;
          errorTag?: string;
        };
        expect(schemas.errorTag).toBeUndefined();
        expect(schemas.count).toBeGreaterThan(0);

        // Thing-scoped reads must be authorized on the thing ARN. Metadata
        // and capabilities succeed even for an unprovisioned device.
        const metadata = (yield* getJson("/metadata")) as {
          managedThingId?: string;
          errorTag?: string;
        };
        expect(metadata.errorTag).toBeUndefined();
        expect(metadata.managedThingId).toBeTruthy();

        const capabilities = (yield* getJson("/capabilities")) as {
          errorTag?: string;
        };
        expect(capabilities.errorTag).toBeUndefined();

        // The remaining routes exercise ops that cannot fully succeed
        // against an unprovisioned device / absent connector: each must
        // answer with data or a TYPED tag that is not an IAM denial —
        // proving the wiring, identifier injection, and grants.
        for (const path of [
          "/state",
          "/certificate",
          "/connectivity",
          "/thing-schemas",
          "/command",
          "/discovery",
          "/discoveries",
          "/get-discovery",
          "/discovered",
          "/connector-event",
          "/custom-endpoint",
        ]) {
          const result = (yield* getJson(path)) as { errorTag?: string };
          expect(result.errorTag).not.toBe("AccessDeniedException");
        }
      }).pipe(Effect.ensuring(sharedStack.destroy().pipe(Effect.orDie)));
    }),
  { timeout: 600_000 },
);
