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
  apigee.getOrganizationsEnvironmentsApisRevisionsDebugsessions({ name }).pipe(
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
  "getOrganizationsEnvironmentsApisRevisionsDebugsessions on a missing session fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEnvironmentsApisRevisionsDebugsessions({
          name: `${org}/environments/eval/apis/missing/revisions/1/debugsessions/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a debug session",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const environment = process.env.GCP_APIGEE_ENVIRONMENT ?? "eval";
      const api = process.env.GCP_APIGEE_API ?? "hello";
      const revision = process.env.GCP_APIGEE_REVISION ?? "1";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.EnvironmentsApisRevisionsDebugsession(
            "Trace",
            {
              environment,
              api,
              revision,
              count: 1,
              validity: 1,
            },
          );
        }),
      );

      expect(created.name).toContain("/debugsessions/");
      expect(created.api).toEqual(api);
      expect(created.revision).toEqual(revision);

      const fetched =
        yield* apigee.getOrganizationsEnvironmentsApisRevisionsDebugsessions({
          name: created.name,
        });
      expect(
        fetched.name === created.debugsessionId ||
          fetched.name === created.name,
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(["gone", "found"]).toContain(gone);
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
