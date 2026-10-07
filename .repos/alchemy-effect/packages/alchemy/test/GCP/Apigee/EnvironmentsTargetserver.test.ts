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
  apigee.getOrganizationsEnvironmentsTargetservers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("ApigeeResourceNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsEnvironmentsTargetservers on a missing server fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEnvironmentsTargetservers({
          name: `${org}/environments/alchemy-missing/targetservers/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an environment target server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            displayName: "runtime",
          });
          const backend = yield* GCP.Apigee.EnvironmentsTargetserver("Api", {
            environment: environment.environmentId,
            host: "backend.example.com",
            port: 443,
            protocol: "HTTP",
            description: "api backend",
            sSLInfo: { enabled: true },
          });
          return { environment, backend };
        }),
      );

      expect(created.backend.targetserverId).toEqual(expect.any(String));
      expect(created.backend.host).toEqual("backend.example.com");
      expect(created.backend.port).toEqual(443);
      expect(created.backend.description).toEqual("api backend");

      const fetched = yield* apigee.getOrganizationsEnvironmentsTargetservers({
        name: created.backend.name,
      });
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("api backend");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            environmentId: created.environment.environmentId,
            displayName: "runtime",
          });
          const backend = yield* GCP.Apigee.EnvironmentsTargetserver("Api", {
            environment: environment.environmentId,
            targetserverId: created.backend.targetserverId,
            host: "backend.example.net",
            port: 443,
            protocol: "HTTP",
            description: "updated api backend",
            sSLInfo: { enabled: true },
          });
          return { environment, backend };
        }),
      );

      expect(updated.backend.name).toEqual(created.backend.name);
      expect(updated.backend.host).toEqual("backend.example.net");
      expect(updated.backend.description).toEqual("updated api backend");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.backend.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
