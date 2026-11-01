import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Needs a provisioned Apigee organization on the testing project (paid, or
// ~1h eval provisioning); without one calls fail with ApigeeResourceNotFound (403 "Permission
// denied on resource \"organizations/{project}\" (or it may not exist)").
// Set GCP_TEST_APIGEE_ORG=1 when the org exists.
const runLifecycle = !!process.env.GCP_TEST_APIGEE_ORG;

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsKeyvaluemapsEntries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("ApigeeResourceNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsKeyvaluemapsEntries on a missing entry fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsKeyvaluemapsEntries({
          name: `${org}/keyvaluemaps/alchemy-missing/entries/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an organization key value map entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.Apigee.Keyvaluemap("Config", {});
          const entry = yield* GCP.Apigee.KeyvaluemapsEntry("ApiKey", {
            map: map.mapId,
            value: "secret-value",
          });
          return { map, entry };
        }),
      );

      expect(created.entry.entryId).toEqual(expect.any(String));
      expect(created.entry.mapId).toEqual(created.map.mapId);
      expect(created.entry.value).toEqual("secret-value");

      const fetched = yield* apigee.getOrganizationsKeyvaluemapsEntries({
        name: created.entry.name,
      });
      expect(fetched.value).toEqual("secret-value");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.Apigee.Keyvaluemap("Config", {
            mapId: created.map.mapId,
          });
          const entry = yield* GCP.Apigee.KeyvaluemapsEntry("ApiKey", {
            map: map.mapId,
            entryId: created.entry.entryId,
            value: "rotated-value",
          });
          return { map, entry };
        }),
      );

      expect(updated.entry.name).toEqual(created.entry.name);
      expect(updated.entry.value).toEqual("rotated-value");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.entry.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
