import * as AWS from "@/AWS";
import { ParallelData } from "@/AWS/Translate/ParallelData.ts";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as translate from "@distilled.cloud/aws/translate";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic fixture names — this suite owns them in the testing account.
const bucketName = "alchemy-test-translate-parallel-data";
const parallelDataName = "alchemy-test-translate-parallel-data";
const objectKey = "examples.csv";

// Checked-in parallel-data CSV — segment-aligned translation examples.
const PARALLEL_CSV = [
  "en,es",
  "Hello world,Hola mundo",
  "Good morning,Buenos días",
  "Thank you very much,Muchas gracias",
].join("\n");

const getParallelData = (name: string) =>
  translate
    .getParallelData({ Name: name })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const cleanupBucket = Effect.gen(function* () {
  yield* s3
    .deleteObject({ Bucket: bucketName, Key: objectKey })
    .pipe(Effect.ignore);
  yield* s3.deleteBucket({ Bucket: bucketName }).pipe(Effect.ignore);
});

// skipIf-gated: CreateParallelData is asynchronous and routinely takes
// several minutes to reach ACTIVE even for a tiny CSV — past the ~90s async
// provisioning budget. The provider is fully implemented (bounded ~10 min
// poll); run the live lifecycle with AWS_TEST_TRANSLATE_PARALLEL_DATA=1.
test.provider.skipIf(!process.env.AWS_TEST_TRANSLATE_PARALLEL_DATA)(
  "lifecycle: create parallel data from S3, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Seed the S3 input out-of-band via distilled.
      yield* s3
        .createBucket({ Bucket: bucketName })
        .pipe(
          Effect.catchTag(
            ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"],
            () => Effect.void,
          ),
        );
      yield* s3.putObject({
        Bucket: bucketName,
        Key: objectKey,
        Body: new TextEncoder().encode(PARALLEL_CSV),
        ContentType: "text/csv",
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ParallelData("TestParallelData", {
            parallelDataName,
            s3Uri: `s3://${bucketName}/${objectKey}`,
            format: "CSV",
            description: "alchemy translate parallel data test",
            tags: { purpose: "alchemy-test" },
          });
        }),
      );
      expect(deployed.parallelDataName).toBe(parallelDataName);
      expect(deployed.parallelDataArn).toContain(
        `:parallel-data/${parallelDataName}`,
      );
      expect(deployed.status).toBe("ACTIVE");
      expect(deployed.sourceLanguageCode).toBe("en");
      expect(deployed.importedRecordCount).toBeGreaterThan(0);

      // Out-of-band verification via distilled.
      const created = yield* getParallelData(parallelDataName);
      expect(created?.ParallelDataProperties?.Status).toBe("ACTIVE");

      // Destroy — the parallel data is gone (delete waits out DELETING).
      yield* stack.destroy();
      const after = yield* getParallelData(parallelDataName);
      expect(after).toBeUndefined();
    }).pipe(Effect.ensuring(cleanupBucket)),
  { timeout: 900_000 },
);
