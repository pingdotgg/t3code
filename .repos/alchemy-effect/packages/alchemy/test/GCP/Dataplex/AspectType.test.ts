import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withDataplexSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const templateA: dataplex.GoogleCloudDataplexV1AspectTypeMetadataTemplate = {
  name: "schema",
  type: "record",
  recordFields: [
    {
      name: "owner",
      type: "string",
      index: 1,
      annotations: { displayName: "Owner" },
    },
  ],
};

const templateB: dataplex.GoogleCloudDataplexV1AspectTypeMetadataTemplate = {
  name: "schema",
  type: "record",
  recordFields: [
    {
      name: "owner",
      type: "string",
      index: 1,
      annotations: { displayName: "Owner" },
    },
    {
      name: "team",
      type: "string",
      index: 2,
      annotations: { displayName: "Team" },
    },
  ],
};

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsAspectTypes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAspectTypes on a missing type fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataplex.getProjectsLocationsAspectTypes({
          name: `projects/${project}/locations/us-central1/aspectTypes/alchemy-missing-aspect`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an aspect type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.AspectType("Schema", {
            location: "us-central1",
            displayName: "schema a",
            description: "type a",
            labels: { env: "test" },
            metadataTemplate: templateA,
          });
        }),
      );

      expect(created.name).toContain("/aspectTypes/");
      expect(created.aspectTypeId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("schema a");
      expect(created.description).toEqual("type a");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsAspectTypes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.AspectType("Schema", {
            aspectTypeId: created.aspectTypeId,
            location: "us-central1",
            displayName: "schema b",
            description: "type b",
            labels: { env: "prod", team: "data" },
            metadataTemplate: templateB,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("schema b");
      expect(updated.description).toEqual("type b");
      expect(updated.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
