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

// Empty `proxies/` directory zip used as archive payload.
const ARCHIVE_ZIP =
  "UEsDBAoAAAAAAIdO4kgAAAAAAAAAAAAAAAAJAAAAcHJveGllcy9QSwECFAAKAAAAAACHTuJIAAAAAAAAAAAAAAAACTAAAAAAAAAAABAAAAAAAAAAcHJveGllcy9QSwUGAAAAAAEAAQA3AAAAJwAAAAAA";

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsEnvironmentsArchiveDeployments({ name }).pipe(
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
  "getOrganizationsEnvironmentsArchiveDeployments on a missing archive fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEnvironmentsArchiveDeployments({
          name: `${org}/environments/alchemy-missing/archiveDeployments/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an archive deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            displayName: "runtime",
          });
          const archive = yield* GCP.Apigee.EnvironmentsArchiveDeployment(
            "Bundle",
            {
              environment: environment.environmentId,
              archiveZip: ARCHIVE_ZIP,
              labels: { env: "test" },
            },
          );
          return { environment, archive };
        }),
      );

      expect(created.archive.archiveDeploymentId).toEqual(expect.any(String));
      expect(created.archive.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.archive.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* apigee.getOrganizationsEnvironmentsArchiveDeployments({
          name: created.archive.name,
        });
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            environmentId: created.environment.environmentId,
            displayName: "runtime",
          });
          const archive = yield* GCP.Apigee.EnvironmentsArchiveDeployment(
            "Bundle",
            {
              environment: environment.environmentId,
              archiveDeploymentId: created.archive.archiveDeploymentId,
              archiveZip: ARCHIVE_ZIP,
              labels: { env: "prod" },
            },
          );
          return { environment, archive };
        }),
      );

      expect(updated.archive.name).toEqual(created.archive.name);
      expect(updated.archive.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.archive.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
