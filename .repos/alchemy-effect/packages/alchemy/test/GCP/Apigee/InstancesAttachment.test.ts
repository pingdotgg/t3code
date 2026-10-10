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
  apigee.getOrganizationsInstancesAttachments({ name }).pipe(
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
  "getOrganizationsInstancesAttachments on a missing attachment fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsInstancesAttachments({
          name: `${org}/instances/alchemy-missing/attachments/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an instance attachment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            displayName: "runtime",
          });
          const runtime = yield* GCP.Apigee.Instance("Runtime", {
            displayName: "runtime",
          });
          const attachment = yield* GCP.Apigee.InstancesAttachment("Bind", {
            instance: runtime.instanceId,
            environment: environment.environmentId,
          });
          return { environment, runtime, attachment };
        }),
      );

      expect(created.attachment.attachmentId).toEqual(expect.any(String));
      expect(created.attachment.instanceId).toEqual(created.runtime.instanceId);
      expect(created.attachment.environment).toEqual(
        created.environment.environmentId,
      );

      const fetched = yield* apigee.getOrganizationsInstancesAttachments({
        name: created.attachment.name,
      });
      expect(fetched.environment).toEqual(created.environment.environmentId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.attachment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
