import * as AWS from "@/AWS";
import { Dataset, Job, Recipe } from "@/AWS/DataBrew";
import { Role } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as databrew from "@distilled.cloud/aws/databrew";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const getJob = (name: string) =>
  databrew
    .describeJob({ Name: name })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const brewRole = () =>
  Role("DataBrewJobRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "databrew.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/service-role/AwsGlueDataBrewServiceRole",
      "arn:aws:iam::aws:policy/AmazonS3FullAccess",
    ],
  });

// Shared foundation: bucket + role + dataset + published recipe.
const foundation = Effect.gen(function* () {
  const bucket = yield* Bucket("JobBucket", { forceDestroy: true });
  const role = yield* brewRole();
  const dataset = yield* Dataset("Source", {
    format: "CSV",
    formatOptions: { csv: { delimiter: ",", headerRow: true } },
    input: {
      s3InputDefinition: { bucket: bucket.bucketName, key: "raw/data.csv" },
    },
  });
  const recipe = yield* Recipe("Transform", {
    publish: true,
    steps: [
      {
        action: {
          operation: "UPPER_CASE",
          parameters: { sourceColumn: "name" },
        },
      },
    ],
  });
  return { bucket, role, dataset, recipe };
});

// CreateProfileJob/CreateRecipeJob validate the dataset's source object with
// the job role, so the CSV is seeded between the foundation and job deploys.
const seedSource = (bucketName: string) =>
  s3.putObject({
    Bucket: bucketName,
    Key: "raw/data.csv",
    Body: new TextEncoder().encode("id,name\n1,alice\n2,bob\n"),
    ContentType: "text/csv",
  });

const withJobs = (maxCapacity: number) =>
  Effect.gen(function* () {
    const base = yield* foundation;
    const profileJob = yield* Job("ProfileJob", {
      type: "PROFILE",
      datasetName: base.dataset.datasetName,
      role: base.role.roleArn,
      outputLocation: { bucket: base.bucket.bucketName, key: "profiles/" },
      jobSample: { mode: "CUSTOM_ROWS", size: 100 },
      maxCapacity,
      timeout: "1 hour",
      tags: { Environment: "test" },
    });
    const recipeJob = yield* Job("RecipeJob", {
      type: "RECIPE",
      datasetName: base.dataset.datasetName,
      recipeReference: { name: base.recipe.recipeName },
      role: base.role.roleArn,
      outputs: [
        {
          location: { bucket: base.bucket.bucketName, key: "curated/" },
          format: "CSV",
          overwrite: true,
        },
      ],
      maxCapacity,
      tags: { Environment: "test" },
    });
    return { ...base, profileJob, recipeJob };
  });

test.provider(
  "create, update, delete profile and recipe job definitions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // stage 1: infrastructure the jobs depend on
      const base = yield* stack.deploy(foundation);
      yield* seedSource(base.bucket.bucketName);

      // stage 2: the job definitions
      const created = yield* stack.deploy(withJobs(2));

      expect(created.profileJob.jobArn).toContain(
        `:job/${created.profileJob.jobName}`,
      );
      expect(created.profileJob.type).toEqual("PROFILE");
      expect(created.recipeJob.type).toEqual("RECIPE");

      // out-of-band verification
      const profile = yield* getJob(created.profileJob.jobName);
      expect(profile?.Type).toEqual("PROFILE");
      expect(profile?.DatasetName).toEqual(created.dataset.datasetName);
      expect(profile?.JobSample?.Size).toEqual(100);
      expect(profile?.MaxCapacity).toEqual(2);
      // Duration.Input "1 hour" lands on the wire as 60 (minutes)
      expect(profile?.Timeout).toEqual(60);
      expect(profile?.Tags?.["alchemy::id"]).toBeDefined();

      const recipeJob = yield* getJob(created.recipeJob.jobName);
      expect(recipeJob?.Type).toEqual("RECIPE");
      expect(recipeJob?.RecipeReference?.Name).toEqual(
        created.recipe.recipeName,
      );
      expect(recipeJob?.Outputs?.[0]?.Location.Bucket).toEqual(
        created.bucket.bucketName,
      );
      expect(recipeJob?.Outputs?.[0]?.Overwrite).toEqual(true);

      // update: bump capacity on both jobs
      yield* stack.deploy(withJobs(3));
      const reProfile = yield* getJob(created.profileJob.jobName);
      expect(reProfile?.MaxCapacity).toEqual(3);
      const reRecipeJob = yield* getJob(created.recipeJob.jobName);
      expect(reRecipeJob?.MaxCapacity).toEqual(3);

      yield* stack.destroy();
      expect(yield* getJob(created.profileJob.jobName)).toBeUndefined();
      expect(yield* getJob(created.recipeJob.jobName)).toBeUndefined();
    }),
  { timeout: 180_000 },
);

// A live DataBrew job run spins up managed Spark capacity (billed per
// node-hour, takes several minutes) — gated behind AWS_TEST_SLOW=1.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "run a live recipe job to success",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(foundation);
      yield* seedSource(base.bucket.bucketName);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const infra = yield* foundation;
          const job = yield* Job("RunJob", {
            type: "RECIPE",
            datasetName: infra.dataset.datasetName,
            recipeReference: { name: infra.recipe.recipeName },
            role: infra.role.roleArn,
            outputs: [
              {
                location: { bucket: infra.bucket.bucketName, key: "curated/" },
                format: "CSV",
                overwrite: true,
              },
            ],
            maxCapacity: 2,
            timeout: "20 minutes",
          });
          return { ...infra, job };
        }),
      );

      const { RunId } = yield* databrew.startJobRun({
        Name: created.job.jobName,
      });

      const run = yield* databrew
        .describeJobRun({ Name: created.job.jobName, RunId })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (r) =>
              r.State === "SUCCEEDED" ||
              r.State === "FAILED" ||
              r.State === "TIMEOUT" ||
              r.State === "STOPPED",
            times: 60,
          }),
        );
      expect(run.State).toEqual("SUCCEEDED");

      // the transformed output landed in S3
      const listed = yield* s3.listObjectsV2({
        Bucket: created.bucket.bucketName,
        Prefix: "curated/",
      });
      expect((listed.KeyCount ?? 0) > 0).toBe(true);

      yield* stack.destroy();
      expect(yield* getJob(created.job.jobName)).toBeUndefined();
    }),
  { timeout: 900_000 },
);
