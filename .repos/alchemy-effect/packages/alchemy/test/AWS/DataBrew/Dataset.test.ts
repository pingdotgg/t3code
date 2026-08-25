import * as AWS from "@/AWS";
import { Dataset } from "@/AWS/DataBrew";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as databrew from "@distilled.cloud/aws/databrew";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getDataset = (name: string) =>
  databrew
    .describeDataset({ Name: name })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

test.provider(
  "create, update, delete DataBrew dataset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DataBucket", { forceDestroy: true });
          const dataset = yield* Dataset("Sales", {
            format: "CSV",
            formatOptions: { csv: { delimiter: ",", headerRow: true } },
            input: {
              s3InputDefinition: {
                bucket: bucket.bucketName,
                key: "raw/sales.csv",
              },
            },
            tags: { Environment: "test" },
          });
          return { bucket, dataset };
        }),
      );

      expect(created.dataset.datasetName).toBeDefined();
      expect(created.dataset.datasetArn).toContain(
        `:dataset/${created.dataset.datasetName}`,
      );

      // out-of-band verification
      const observed = yield* getDataset(created.dataset.datasetName);
      expect(observed?.Name).toEqual(created.dataset.datasetName);
      expect(observed?.Format).toEqual("CSV");
      expect(observed?.Input.S3InputDefinition?.Bucket).toEqual(
        created.bucket.bucketName,
      );
      expect(observed?.Input.S3InputDefinition?.Key).toEqual("raw/sales.csv");
      expect(observed?.FormatOptions?.Csv?.Delimiter).toEqual(",");
      expect(observed?.Tags?.["alchemy::id"]).toBeDefined();
      expect(observed?.Tags?.Environment).toEqual("test");

      // update: different key + delimiter + tag change
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DataBucket", { forceDestroy: true });
          const dataset = yield* Dataset("Sales", {
            format: "CSV",
            formatOptions: { csv: { delimiter: ";", headerRow: false } },
            input: {
              s3InputDefinition: {
                bucket: bucket.bucketName,
                key: "raw/sales-v2.csv",
              },
            },
            tags: { Environment: "staging" },
          });
          return { dataset };
        }),
      );

      const reobserved = yield* getDataset(created.dataset.datasetName);
      expect(reobserved?.Input.S3InputDefinition?.Key).toEqual(
        "raw/sales-v2.csv",
      );
      expect(reobserved?.FormatOptions?.Csv?.Delimiter).toEqual(";");
      expect(reobserved?.Tags?.Environment).toEqual("staging");

      yield* stack.destroy();
      const gone = yield* getDataset(created.dataset.datasetName);
      expect(gone).toBeUndefined();
    }),
  { timeout: 120_000 },
);

test.provider(
  "changing the dataset name replaces the dataset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const nameA = "alchemy-test-databrew-dataset-a";
      const nameB = "alchemy-test-databrew-dataset-b";

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DataBucket", { forceDestroy: true });
          const dataset = yield* Dataset("Named", {
            datasetName: nameA,
            format: "CSV",
            input: {
              s3InputDefinition: {
                bucket: bucket.bucketName,
                key: "raw/data.csv",
              },
            },
          });
          return { bucket, dataset };
        }),
      );
      expect(first.dataset.datasetName).toEqual(nameA);

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DataBucket", { forceDestroy: true });
          const dataset = yield* Dataset("Named", {
            datasetName: nameB,
            format: "CSV",
            input: {
              s3InputDefinition: {
                bucket: bucket.bucketName,
                key: "raw/data.csv",
              },
            },
          });
          return { dataset };
        }),
      );
      expect(second.dataset.datasetName).toEqual(nameB);

      // the old dataset is gone, the new one exists
      expect(yield* getDataset(nameA)).toBeUndefined();
      expect((yield* getDataset(nameB))?.Name).toEqual(nameB);

      yield* stack.destroy();
      expect(yield* getDataset(nameB)).toBeUndefined();
    }),
  { timeout: 120_000 },
);
