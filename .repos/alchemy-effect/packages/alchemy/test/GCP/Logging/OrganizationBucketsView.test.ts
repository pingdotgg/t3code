import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

// Organization-scoped: set GOOGLE_ORGANIZATION_ID when the credentials
// administer the organization (the testing service account does not).
const organizationId = process.env.GOOGLE_ORGANIZATION_ID?.trim().replace(
  /^organizations\//,
  "",
);
const organization = `organizations/${organizationId}`;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  logging.getOrganizationsLocationsBucketsViews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!organizationId)(
  "getOrganizationsLocationsBucketsViews on a missing view fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        logging.getOrganizationsLocationsBucketsViews({
          name: `${organization}/locations/global/buckets/_Default/views/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId)(
  "create, update, replace, and delete an organization logging bucket view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationBucketsView("Stdout", {
            organization,
            filter: 'LOG_ID("stdout")',
            description: "stdout only",
          });
        }),
      );

      expect(created.viewId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.bucketId).toEqual("_Default");
      expect(created.filter).toEqual('LOG_ID("stdout")');
      expect(created.description).toEqual("stdout only");

      const fetched = yield* logging.getOrganizationsLocationsBucketsViews({
        name: created.name,
      });
      expect(fetched.filter).toEqual('LOG_ID("stdout")');
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationBucketsView("Stdout", {
            organization,
            viewId: created.viewId,
            bucket: created.bucket,
            filter: 'LOG_ID("stderr")',
            description: "stderr only",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.filter).toEqual('LOG_ID("stderr")');

      const last = created.viewId.at(-1) ?? "a";
      const nextViewId = `${created.viewId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.OrganizationBucketsView("Stdout", {
            organization,
            viewId: nextViewId,
            bucket: created.bucket,
            filter: 'LOG_ID("stdout")',
            description: "replaced view",
          });
        }),
      );

      expect(replaced.viewId).not.toEqual(created.viewId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
