import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !!process.env.GCP_TEST_BYOIP && !process.env.FAST;

const parentPrefix = process.env.GCP_TEST_PAP_PARENT ?? "";
const ipCidrRange = process.env.GCP_TEST_PDP_RANGE ?? "203.0.113.0/24";

const waitUntilGone = (project: string, publicDelegatedPrefix: string) =>
  compute
    .getGlobalPublicDelegatedPrefixes({ project, publicDelegatedPrefix })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "insertGlobalPublicDelegatedPrefixes with a malformed parentPrefix fails with BadRequest",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.insertGlobalPublicDelegatedPrefixes({
          project,
          body: {
            name: "alchemy-pdp-probe",
            description: "alchemy entitlement probe",
            parentPrefix: parentPrefix || "does-not-exist",
            ipCidrRange,
          },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle || !parentPrefix)(
  "create, update, and delete a global public delegated prefix",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.GlobalPublicDelegatedPrefix("Byoip", {
            parentPrefix,
            ipCidrRange,
            description: "delegated range",
          });
        }),
      );

      expect(created.prefixName).toEqual(expect.any(String));
      expect(created.ipCidrRange).toEqual(ipCidrRange);
      expect(created.description).toEqual("delegated range");

      const fetched = yield* compute.getGlobalPublicDelegatedPrefixes({
        project: created.project,
        publicDelegatedPrefix: created.prefixName,
      });
      expect(fetched.name).toEqual(created.prefixName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.GlobalPublicDelegatedPrefix("Byoip", {
            prefixName: created.prefixName,
            parentPrefix,
            ipCidrRange,
            description: "updated range",
          });
        }),
      );
      expect(updated.description).toEqual("updated range");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.project, created.prefixName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
