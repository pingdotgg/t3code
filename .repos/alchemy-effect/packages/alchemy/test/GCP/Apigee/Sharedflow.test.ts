import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { unzipFiles } from "@/Util/zip.ts";
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
  apigee.getOrganizationsSharedflows({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const descriptionFromBundle = (body: apigee.GoogleApiHttpBody) =>
  Effect.gen(function* () {
    const data = body.data;
    if (data === undefined || data.length === 0) return "";
    const bytes = yield* Effect.sync(() => Buffer.from(data, "base64"));
    const entries = yield* unzipFiles(bytes);
    const xmlPath = Object.keys(entries).find((path) =>
      /^sharedflowbundle\/[^/]+\.xml$/i.test(path),
    );
    if (xmlPath === undefined) return "";
    return yield* Effect.sync(() =>
      Buffer.from(entries[xmlPath]!).toString("utf8"),
    );
  });

test.provider(
  "getOrganizationsSharedflows on a missing shared flow fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsSharedflows({
          name: `organizations/${project}/sharedflows/alchemy-apigee-missing-flow`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Apigee shared flow",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.Sharedflow("Traffic", {
            description: "alchemy test shared flow",
          });
        }),
      );

      expect(created.sharedflowId).toEqual(expect.any(String));
      expect(created.organization).toEqual(project);
      expect(created.name).toEqual(
        `organizations/${project}/sharedflows/${created.sharedflowId}`,
      );
      expect(created.description).toEqual("alchemy test shared flow");
      expect(created.latestRevisionId).toEqual(expect.any(String));

      const fetched = yield* apigee.getOrganizationsSharedflows({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.sharedflowId);

      const revision = yield* apigee.getOrganizationsSharedflowsRevisions({
        name: `${created.name}/revisions/${created.latestRevisionId}`,
        format: "bundle",
      });
      const createdXml = yield* descriptionFromBundle(revision);
      expect(createdXml).toContain("alchemy-id=");
      expect(createdXml).toContain("alchemy test shared flow");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.Sharedflow("Traffic", {
            sharedflowId: created.sharedflowId,
            description: "alchemy updated shared flow",
          });
        }),
      );

      expect(updated.sharedflowId).toEqual(created.sharedflowId);
      expect(updated.description).toEqual("alchemy updated shared flow");
      expect(updated.latestRevisionId).not.toEqual(created.latestRevisionId);

      const fetchedRevision =
        yield* apigee.getOrganizationsSharedflowsRevisions({
          name: `${updated.name}/revisions/${updated.latestRevisionId}`,
          format: "bundle",
        });
      const updatedXml = yield* descriptionFromBundle(fetchedRevision);
      expect(updatedXml).toContain("alchemy updated shared flow");
      expect(updatedXml).toContain("alchemy-id=");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);
