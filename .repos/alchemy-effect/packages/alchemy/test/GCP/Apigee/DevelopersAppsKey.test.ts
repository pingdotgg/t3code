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
  apigee.getOrganizationsDevelopersAppsKeys({ name }).pipe(
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
  "getOrganizationsDevelopersAppsKeys on a missing key fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsDevelopersAppsKeys({
          name: `${org}/developers/missing@alchemy.example/apps/missing-app/keys/missing-key`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a developer app key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const developer = yield* GCP.Apigee.Developer("Owner", {
            firstName: "Ada",
            lastName: "Lovelace",
          });
          const app = yield* GCP.Apigee.DevelopersApp("Portal", {
            developer: developer.email,
          });
          const key = yield* GCP.Apigee.DevelopersAppsKey("PortalKey", {
            developer: developer.email,
            app: app.appName,
            attributes: { team: "platform" },
          });
          return { developer, app, key };
        }),
      );

      expect(created.key.consumerKey).toEqual(expect.any(String));
      expect(created.key.attributes).toMatchObject({ team: "platform" });

      const fetched = yield* apigee.getOrganizationsDevelopersAppsKeys({
        name: created.key.name,
      });
      expect(fetched.consumerKey).toEqual(created.key.consumerKey);
      expect(
        fetched.attributes?.some((item) => item.name === "alchemy-id"),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const developer = yield* GCP.Apigee.Developer("Owner", {
            email: created.developer.email,
            firstName: "Ada",
            lastName: "Lovelace",
          });
          const app = yield* GCP.Apigee.DevelopersApp("Portal", {
            developer: developer.email,
            appName: created.app.appName,
          });
          const key = yield* GCP.Apigee.DevelopersAppsKey("PortalKey", {
            developer: developer.email,
            app: app.appName,
            consumerKey: created.key.consumerKey,
            consumerSecret: created.key.consumerSecret,
            attributes: { team: "runtime" },
          });
          return { developer, app, key };
        }),
      );

      expect(updated.key.name).toEqual(created.key.name);
      expect(updated.key.attributes).toMatchObject({ team: "runtime" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.key.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
