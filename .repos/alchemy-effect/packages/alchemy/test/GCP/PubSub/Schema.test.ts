import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const AVRO_V1 = JSON.stringify({
  type: "record",
  name: "Event",
  fields: [{ name: "id", type: "string" }],
});

const AVRO_V2 = JSON.stringify({
  type: "record",
  name: "Event",
  fields: [
    { name: "id", type: "string" },
    { name: "count", type: "int", default: 0 },
  ],
});

const waitUntilGone = (name: string) =>
  pubsub.getProjectsSchemas({ name, view: "BASIC" }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PubSub.Schema("Events", {
            type: "AVRO",
            definition: AVRO_V1,
          });
        }),
      );

      expect(created.name).toContain("/schemas/");
      expect(created.schemaId).toEqual(expect.any(String));
      expect(created.type).toEqual("AVRO");
      expect(created.definition).toContain("string");
      expect(created.revisionId).toEqual(expect.any(String));

      const fetched = yield* pubsub.getProjectsSchemas({
        name: created.name,
        view: "FULL",
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.type).toEqual("AVRO");
      expect(fetched.definition).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PubSub.Schema("Events", {
            schemaId: created.schemaId,
            type: "AVRO",
            definition: AVRO_V2,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.type).toEqual("AVRO");
      expect(updated.revisionId).toEqual(expect.any(String));
      expect(updated.revisionId).not.toEqual(created.revisionId);
      expect(updated.definition).toContain("count");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 90_000 },
);
