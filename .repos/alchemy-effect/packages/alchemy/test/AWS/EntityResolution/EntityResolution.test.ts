import * as AWS from "@/AWS";
import {
  IdMappingWorkflow,
  IdNamespace,
  MatchingWorkflow,
  SchemaMapping,
} from "@/AWS/EntityResolution";
import { toTagRecord } from "@/AWS/EntityResolution/internal.ts";
import { Database, Table } from "@/AWS/Glue";
import { Role } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Typed-error probe: proves the SDK decodes Entity Resolution errors as
// typed tags. A missing workflow surfaces as ResourceNotFoundException.
test.provider(
  "getMatchingWorkflow on a nonexistent name fails with a typed error",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        entityresolution.getMatchingWorkflow({
          workflowName: "does-not-exist-alchemy-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const CUSTOMER_FIELDS: entityresolution.SchemaInputAttribute[] = [
  { fieldName: "id", type: "UNIQUE_ID" },
  { fieldName: "email", type: "EMAIL_ADDRESS", matchKey: "email" },
  { fieldName: "name", type: "NAME", matchKey: "name" },
];

/**
 * The role Entity Resolution assumes to read the Glue input table (and its
 * underlying S3 data) and write matched output to S3.
 */
const workflowRole = () =>
  Role("EntityResolutionRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "entityresolution.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    inlinePolicies: {
      workflow: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "glue:GetDatabase",
              "glue:GetTable",
              "glue:GetPartition",
              "glue:GetPartitions",
              "glue:GetSchema",
              "glue:GetSchemaVersion",
            ],
            Resource: ["*"],
          },
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:ListBucket", "s3:PutObject"],
            Resource: ["*"],
          },
        ],
      },
    },
  });

/** The full stack under test: bucket → Glue table → schema → workflow. */
const workflowStack = (variant: "v1" | "v2") =>
  Effect.gen(function* () {
    const bucket = yield* Bucket("ErBucket", { forceDestroy: true });
    const role = yield* workflowRole();
    const database = yield* Database("ErDb", {});
    const table = yield* Table("Customers", {
      databaseName: database.databaseName,
      storageDescriptor: {
        location: Output.interpolate`s3://${bucket.bucketName}/input/`,
        inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
        outputFormat:
          "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
        serdeInfo: {
          serializationLibrary:
            "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
          parameters: { "field.delim": ",", "skip.header.line.count": "1" },
        },
        columns: [
          { name: "id", type: "string" },
          { name: "email", type: "string" },
          { name: "name", type: "string" },
        ],
      },
      parameters: { classification: "csv" },
    });
    const schema = yield* SchemaMapping("CustomersSchema", {
      description: "Customer records schema",
      mappedInputFields: CUSTOMER_FIELDS,
      tags: { Environment: "test" },
    });
    const workflow = yield* MatchingWorkflow("Dedupe", {
      description:
        variant === "v1"
          ? "Match customers by email"
          : "Match by email or name",
      inputSourceConfig: [
        { inputSourceARN: table.tableArn, schemaName: schema.schemaName },
      ],
      outputSourceConfig: [
        {
          outputS3Path: Output.interpolate`s3://${bucket.bucketName}/matches/`,
          output: [{ name: "id" }, { name: "email" }, { name: "name" }],
        },
      ],
      resolutionTechniques: {
        resolutionType: "RULE_MATCHING",
        ruleBasedProperties: {
          rules:
            variant === "v1"
              ? [{ ruleName: "ByEmail", matchingKeys: ["email"] }]
              : [
                  { ruleName: "ByEmail", matchingKeys: ["email"] },
                  { ruleName: "ByName", matchingKeys: ["name"] },
                ],
          attributeMatchingModel: "ONE_TO_ONE",
        },
      },
      roleArn: role.roleArn,
      tags: { Environment: "test" },
    });
    return { bucket, role, database, table, schema, workflow };
  });

// Schema mappings and matching workflow DEFINITIONS are cheap and instant —
// the live lifecycle runs ungated with out-of-band verification. The
// matching RUN (StartMatchingJob) takes many minutes and is gated below.
test.provider(
  "create, update, destroy a schema mapping and matching workflow",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(workflowStack("v1"));

      expect(created.schema.schemaArn).toContain(":schemamapping/");
      expect(created.workflow.workflowArn).toContain(":matchingworkflow/");

      // Out-of-band verification via distilled.
      const observedSchema = yield* entityresolution.getSchemaMapping({
        schemaName: created.schema.schemaName,
      });
      expect(observedSchema.mappedInputFields).toEqual(CUSTOMER_FIELDS);
      // Entity Resolution Get* ops do not return tags — verify via
      // listTagsForResource.
      const schemaTags = yield* entityresolution.listTagsForResource({
        resourceArn: created.schema.schemaArn,
      });
      expect(toTagRecord(schemaTags.tags)["alchemy::id"]).toBe(
        "CustomersSchema",
      );
      expect(toTagRecord(schemaTags.tags).Environment).toBe("test");

      const observedWorkflow = yield* entityresolution.getMatchingWorkflow({
        workflowName: created.workflow.workflowName,
      });
      expect(observedWorkflow.description).toBe("Match customers by email");
      expect(observedWorkflow.roleArn).toBe(created.role.roleArn);
      expect(observedWorkflow.inputSourceConfig[0]?.schemaName).toBe(
        created.schema.schemaName,
      );
      expect(
        observedWorkflow.resolutionTechniques.ruleBasedProperties?.rules.map(
          (r) => r.ruleName,
        ),
      ).toEqual(["ByEmail"]);
      const workflowTags = yield* entityresolution.listTagsForResource({
        resourceArn: created.workflow.workflowArn,
      });
      expect(toTagRecord(workflowTags.tags)["alchemy::id"]).toBe("Dedupe");

      // Update in place: workflow description + an extra matching rule.
      // (The schema mapping is left untouched — it is immutable while the
      // workflow references it.)
      const updated = yield* stack.deploy(workflowStack("v2"));
      expect(updated.workflow.workflowArn).toBe(created.workflow.workflowArn);
      expect(updated.schema.schemaArn).toBe(created.schema.schemaArn);

      const reobserved = yield* entityresolution.getMatchingWorkflow({
        workflowName: created.workflow.workflowName,
      });
      expect(reobserved.description).toBe("Match by email or name");
      expect(
        reobserved.resolutionTechniques.ruleBasedProperties?.rules.map(
          (r) => r.ruleName,
        ),
      ).toEqual(["ByEmail", "ByName"]);

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      const workflowError = yield* Effect.flip(
        entityresolution.getMatchingWorkflow({
          workflowName: created.workflow.workflowName,
        }),
      );
      expect(workflowError._tag).toBe("ResourceNotFoundException");
      const schemaError = yield* Effect.flip(
        entityresolution.getSchemaMapping({
          schemaName: created.schema.schemaName,
        }),
      );
      expect(schemaError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 300_000 },
);

// The matching RUN processes the full input through the Entity Resolution
// service and takes several minutes even for a 4-row input — gated so an
// explicitly-opted-in run can exercise it end-to-end.
test.provider.skipIf(!process.env.AWS_TEST_ENTITYRESOLUTION_RUN)(
  "run a rule-based matching job end-to-end (gated)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(workflowStack("v1"));

      // Seed input records — two obvious duplicates by email.
      yield* s3.putObject({
        Bucket: created.bucket.bucketName,
        Key: "input/customers.csv",
        Body: new TextEncoder().encode(
          "id,email,name\n" +
            "1,jane@example.com,Jane Doe\n" +
            "2,jane@example.com,Jane D\n" +
            "3,bob@example.com,Bob Roe\n" +
            "4,alice@example.com,Alice Poe\n",
        ),
        ContentType: "text/csv",
      });

      const { jobId } = yield* entityresolution.startMatchingJob({
        workflowName: created.workflow.workflowName,
      });

      const job = yield* entityresolution
        .getMatchingJob({
          workflowName: created.workflow.workflowName,
          jobId,
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (j) => j.status === "SUCCEEDED" || j.status === "FAILED",
            times: 36,
          }),
        );
      expect(job.status).toBe("SUCCEEDED");
      expect(job.metrics?.inputRecords).toBe(4);

      yield* stack.destroy();
    }),
  { timeout: 900_000 },
);
