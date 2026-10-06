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
  apigee.getOrganizationsApisKeyvaluemaps({ name }).pipe(
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
  "getOrganizationsApisKeyvaluemaps on a missing map fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsApisKeyvaluemaps({
          name: `${org}/apis/missing-api/keyvaluemaps/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an api key value map",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apigee.Api("Orders", {});
          const map = yield* GCP.Apigee.ApisKeyvaluemap("Config", {
            api: api.apiId,
          });
          return { api, map };
        }),
      );

      expect(created.map.mapId).toEqual(expect.any(String));
      expect(created.map.apiId).toEqual(created.api.apiId);
      expect(created.map.maskedValues).toEqual(false);

      const fetched = yield* apigee.getOrganizationsApisKeyvaluemaps({
        name: created.map.name,
      });
      expect(
        fetched.name === created.map.mapId || fetched.name === created.map.name,
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apigee.Api("Orders", {
            apiId: created.api.apiId,
          });
          const map = yield* GCP.Apigee.ApisKeyvaluemap("Config", {
            api: api.apiId,
            mapId: created.map.mapId,
            maskedValues: true,
          });
          return { api, map };
        }),
      );

      expect(updated.map.name).toEqual(created.map.name);
      expect(updated.map.maskedValues).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.map.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
