import * as AWS from "@/AWS";
import { DataCatalog } from "@/AWS/Athena/DataCatalog.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as athena from "@distilled.cloud/aws/athena";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const catalogName = "alchemy_test_catalog";
const fnA =
  "arn:aws:lambda:us-west-2:391965393224:function:alchemy-athena-cat-a";
const fnB =
  "arn:aws:lambda:us-west-2:391965393224:function:alchemy-athena-cat-b";

const getCatalog = athena
  .getDataCatalog({ Name: catalogName, WorkGroup: "primary" })
  .pipe(
    Effect.map((res) => res.DataCatalog),
    Effect.catchTag("DataCatalogNotFound", () => Effect.succeed(undefined)),
  );

test.provider(
  "lifecycle: create LAMBDA catalog, update params/description, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — a federated LAMBDA connector (a fake function ARN is accepted
      // at create time; Athena validates lazily at query time).
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DataCatalog("LifecycleCat", {
            name: catalogName,
            type: "LAMBDA",
            description: "initial",
            parameters: { "metadata-function": fnA, "record-function": fnA },
            tags: { env: "test" },
          });
        }),
      );
      expect(created.dataCatalogArn).toContain(`datacatalog/${catalogName}`);
      expect(created.type).toBe("LAMBDA");

      // Out-of-band verification via distilled.
      const observed = yield* getCatalog;
      expect(observed?.Type).toBe("LAMBDA");
      expect(observed?.Parameters?.["metadata-function"]).toBe(fnA);
      expect(observed?.Description).toBe("initial");

      // Tags applied.
      const tags = yield* athena.listTagsForResource({
        ResourceARN: created.dataCatalogArn,
      });
      expect(
        tags.Tags?.some((t) => t.Key === "env" && t.Value === "test"),
      ).toBe(true);

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(DataCatalog);
      const all = yield* provider.list();
      expect(all.some((c) => c.name === catalogName)).toBe(true);

      // Update — change the record-function param + description in place.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DataCatalog("LifecycleCat", {
            name: catalogName,
            type: "LAMBDA",
            description: "updated",
            parameters: { "metadata-function": fnA, "record-function": fnB },
          });
        }),
      );
      const updated = yield* getCatalog;
      expect(updated?.Parameters?.["record-function"]).toBe(fnB);
      expect(updated?.Description).toBe("updated");

      // Destroy — the catalog is removed.
      yield* stack.destroy();
      const after = yield* getCatalog;
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
