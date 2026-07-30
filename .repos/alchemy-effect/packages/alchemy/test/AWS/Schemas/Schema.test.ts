import * as AWS from "@/AWS";
import { Registry, Schema } from "@/AWS/Schemas";
import * as Test from "@/Test/Alchemy";
import * as schemas from "@distilled.cloud/aws/schemas";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const contentV1 = JSON.stringify({
  openapi: "3.0.0",
  info: { version: "1.0.0", title: "OrderCreated" },
  paths: {},
  components: {
    schemas: {
      OrderCreated: {
        type: "object",
        properties: {
          orderId: { type: "string" },
        },
      },
    },
  },
});

const contentV2 = JSON.stringify({
  openapi: "3.0.0",
  info: { version: "1.0.0", title: "OrderCreated" },
  paths: {},
  components: {
    schemas: {
      OrderCreated: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          amount: { type: "number" },
        },
      },
    },
  },
});

const assertSchemaGone = (registryName: string, schemaName: string) =>
  schemas
    .describeSchema({ RegistryName: registryName, SchemaName: schemaName })
    .pipe(
      Effect.flatMap(() =>
        Effect.fail(new Error(`schema ${schemaName} still exists`)),
      ),
      Effect.catchTag("NotFoundException", () => Effect.void),
      Effect.retry({
        while: (e) => e instanceof Error,
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(10),
        ]),
      }),
    );

describe("AWS.Schemas.Schema", () => {
  test.provider(
    "creates a schema, publishes a new version on content change, and deletes it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // CREATE — registry + schema.
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const registry = yield* Registry("SchemaTestRegistry", {});
            const schema = yield* Schema("OrderCreated", {
              registryName: registry.registryName,
              type: "OpenApi3",
              content: contentV1,
              description: "Order created event",
              tags: { purpose: "alchemy-test" },
            });
            return {
              registryName: registry.registryName,
              schemaName: schema.schemaName,
              schemaArn: schema.schemaArn,
              schemaVersion: schema.schemaVersion,
            };
          }),
        );
        expect(created.schemaVersion).toEqual("1");

        // Verify out-of-band via distilled.
        const observed = yield* schemas.describeSchema({
          RegistryName: created.registryName,
          SchemaName: created.schemaName,
        });
        expect(observed.SchemaArn).toEqual(created.schemaArn);
        expect(observed.Type).toEqual("OpenApi3");
        expect(observed.Description).toEqual("Order created event");
        expect(JSON.parse(observed.Content!)).toEqual(JSON.parse(contentV1));
        expect(observed.Tags?.purpose).toEqual("alchemy-test");
        expect(observed.Tags?.["alchemy::id"]).toEqual("OrderCreated");

        // NO-OP — redeploying identical desired state must not publish a new
        // schema version (content comparison is canonical).
        const noop = yield* stack.deploy(
          Effect.gen(function* () {
            const registry = yield* Registry("SchemaTestRegistry", {});
            const schema = yield* Schema("OrderCreated", {
              registryName: registry.registryName,
              type: "OpenApi3",
              content: contentV1,
              description: "Order created event",
              tags: { purpose: "alchemy-test" },
            });
            return { schemaVersion: schema.schemaVersion };
          }),
        );
        expect(noop.schemaVersion).toEqual("1");

        // UPDATE — new content publishes a new schema version.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const registry = yield* Registry("SchemaTestRegistry", {});
            const schema = yield* Schema("OrderCreated", {
              registryName: registry.registryName,
              type: "OpenApi3",
              content: contentV2,
              description: "Order created event",
              tags: { purpose: "alchemy-test" },
            });
            return {
              schemaName: schema.schemaName,
              schemaVersion: schema.schemaVersion,
            };
          }),
        );
        expect(updated.schemaName).toEqual(created.schemaName);
        expect(updated.schemaVersion).toEqual("2");

        const afterUpdate = yield* schemas.describeSchema({
          RegistryName: created.registryName,
          SchemaName: created.schemaName,
        });
        expect(JSON.parse(afterUpdate.Content!)).toEqual(JSON.parse(contentV2));

        // DELETE
        yield* stack.destroy();
        yield* assertSchemaGone(created.registryName, created.schemaName);
      }),
    { timeout: 120_000 },
  );
});
