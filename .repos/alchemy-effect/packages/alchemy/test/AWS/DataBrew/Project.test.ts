import * as AWS from "@/AWS";
import { Dataset, Project, Recipe } from "@/AWS/DataBrew";
import { Role } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as databrew from "@distilled.cloud/aws/databrew";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getProject = (name: string) =>
  databrew
    .describeProject({ Name: name })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const brewRole = () =>
  Role("DataBrewProjectRole", {
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

// CreateProject validates that the dataset's source object exists (it reads
// the interactive sample), so the CSV is seeded between the two deploys.
test.provider(
  "create, update, delete DataBrew project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const foundation = Effect.gen(function* () {
        const bucket = yield* Bucket("ProjectBucket", { forceDestroy: true });
        const role = yield* brewRole();
        const dataset = yield* Dataset("Source", {
          format: "CSV",
          formatOptions: { csv: { delimiter: ",", headerRow: true } },
          input: {
            s3InputDefinition: {
              bucket: bucket.bucketName,
              key: "raw/data.csv",
            },
          },
        });
        const recipe = yield* Recipe("Transform", {
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

      const withProject = (sample?: {
        type: "FIRST_N" | "LAST_N" | "RANDOM";
        size?: number;
      }) =>
        Effect.gen(function* () {
          const base = yield* foundation;
          const project = yield* Project("Explore", {
            datasetName: base.dataset.datasetName,
            recipeName: base.recipe.recipeName,
            sample,
            role: base.role.roleArn,
            tags: { Environment: "test" },
          });
          return { ...base, project };
        });

      // stage 1: bucket + dataset + recipe (no project yet)
      const base = yield* stack.deploy(foundation);

      // seed the source object CreateProject samples from
      yield* s3.putObject({
        Bucket: base.bucket.bucketName,
        Key: "raw/data.csv",
        Body: new TextEncoder().encode("id,name\n1,alice\n2,bob\n"),
        ContentType: "text/csv",
      });

      // stage 2: add the project
      const created = yield* stack.deploy(withProject());

      expect(created.project.projectName).toBeDefined();
      expect(created.project.projectArn).toContain(
        `:project/${created.project.projectName}`,
      );

      // out-of-band verification
      const observed = yield* getProject(created.project.projectName);
      expect(observed?.Name).toEqual(created.project.projectName);
      expect(observed?.DatasetName).toEqual(created.dataset.datasetName);
      expect(observed?.RecipeName).toEqual(created.recipe.recipeName);
      expect(observed?.Tags?.["alchemy::id"]).toBeDefined();

      // update: change the sample
      yield* stack.deploy(withProject({ type: "RANDOM", size: 250 }));

      const reobserved = yield* getProject(created.project.projectName);
      expect(reobserved?.Sample?.Type).toEqual("RANDOM");
      expect(reobserved?.Sample?.Size).toEqual(250);

      yield* stack.destroy();
      const gone = yield* getProject(created.project.projectName);
      expect(gone).toBeUndefined();
    }),
  { timeout: 180_000 },
);
