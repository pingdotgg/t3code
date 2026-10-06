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

const waitUntilGone = (parent: string, fileType: string, fileId: string) =>
  apigee
    .getOrganizationsEnvironmentsResourcefiles({
      parent,
      type: fileType,
      name: fileId,
    })
    .pipe(
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
  "getOrganizationsEnvironmentsResourcefiles on a missing file fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEnvironmentsResourcefiles({
          parent: `${org}/environments/alchemy-missing`,
          type: "js",
          name: "alchemy-missing",
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an environment resource file",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            displayName: "runtime",
          });
          const file = yield* GCP.Apigee.EnvironmentsResourcefile("Helper", {
            environment: environment.environmentId,
            fileType: "js",
            content: "function helper() { return 1; }",
          });
          return { environment, file };
        }),
      );

      expect(created.file.fileId).toEqual(expect.any(String));
      expect(created.file.fileType).toEqual("js");
      expect(created.file.environmentId).toEqual(
        created.environment.environmentId,
      );

      const fetched = yield* apigee.getOrganizationsEnvironmentsResourcefiles({
        parent: created.file.parent,
        type: created.file.fileType,
        name: created.file.fileId,
      });
      expect(
        fetched.data !== undefined || fetched.contentType !== undefined,
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            environmentId: created.environment.environmentId,
            displayName: "runtime",
          });
          const file = yield* GCP.Apigee.EnvironmentsResourcefile("Helper", {
            environment: environment.environmentId,
            fileType: "js",
            fileId: created.file.fileId,
            content: "function helper() { return 2; }",
          });
          return { environment, file };
        }),
      );

      expect(updated.file.fileId).toEqual(created.file.fileId);
      expect(updated.file.parent).toEqual(created.file.parent);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.file.parent,
        created.file.fileType,
        created.file.fileId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
