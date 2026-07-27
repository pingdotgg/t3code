import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM/Role.ts";
import { Workflow } from "@/AWS/MWAAServerless";
import { Bucket } from "@/AWS/S3/Bucket.ts";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Typed-error probe: prove the distilled error union carries the not-found
// tag this provider's read/delete paths depend on, at near-zero cost.
test.provider(
  "getWorkflow on a nonexistent workflow fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const identity = yield* sts.getCallerIdentity({});
      const region = process.env.AWS_REGION ?? "us-west-2";
      // Workflow ARNs end in `-{10 alnum chars}` (a service-assigned id
      // suffix) — the API rejects anything else with a ValidationException
      // before the lookup even runs.
      const bogusArn = `arn:aws:airflow-serverless:${region}:${identity.Account}:workflow/alchemy-nonexistent-probe-0123456789`;
      const error = yield* Effect.flip(
        mwaa.getWorkflow({ WorkflowArn: bogusArn }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// A deterministic, checked-in workflow definition (YAML DAG using a
// supported AWS operator). The bucket name is interpolated because the
// definition must reference a real bucket the execution role can list.
const workflowDefinition = (bucket: string) =>
  [
    "alchemy-mwaa-serverless-test:",
    "  default_args:",
    "    owner: alchemy",
    "  schedule: null",
    "  tasks:",
    "    list_definitions:",
    "      operator: airflow.providers.amazon.aws.operators.s3.S3ListOperator",
    `      bucket: ${bucket}`,
    "      prefix: workflows/",
    "",
  ].join("\n");

const DEFINITION_KEY = "workflows/test.yaml";

// The definition bucket + execution role, shared by every deploy phase of
// the gated lifecycle (same logical IDs across incremental deploys).
const infrastructure = Effect.gen(function* () {
  const bucket = yield* Bucket("Definitions", { forceDestroy: true });
  const role = yield* Role("WorkflowRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "airflow-serverless.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    inlinePolicies: {
      definitions: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"],
            Resource: [
              bucket.bucketArn,
              Output.interpolate`${bucket.bucketArn}/*`,
            ],
          },
        ],
      },
    },
  });
  return { bucket, role };
});

const workflowPhase = (description: string, name?: string) =>
  Effect.gen(function* () {
    const { bucket, role } = yield* infrastructure;
    const workflow = yield* Workflow("Etl", {
      name,
      definitionS3Location: {
        bucket: bucket.bucketName,
        objectKey: DEFINITION_KEY,
      },
      roleArn: role.roleArn,
      description,
      tags: { fixture: "mwaa-serverless-workflow" },
    });
    return { bucket, role, workflow };
  });

const findWorkflow = (workflowArn: string) =>
  mwaa
    .getWorkflow({ WorkflowArn: workflowArn })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

class WorkflowStillExists extends Data.TaggedError("WorkflowStillExists")<{
  readonly workflowArn: string;
}> {}

class LogGroupStillExists extends Data.TaggedError("LogGroupStillExists")<{
  readonly logGroupName: string;
}> {}

// MWAA Serverless auto-creates `/aws/mwaa-serverless/{arn resource id}/`
// per workflow; the provider's delete reaps it. Derive the exact name from
// the workflow ARN (the resource id embeds the service-assigned suffix).
const logGroupNameFor = (workflowArn: string) =>
  `/aws/mwaa-serverless/${workflowArn.split(":workflow/")[1]}/`;

const assertLogGroupDeleted = (workflowArn: string) =>
  Effect.gen(function* () {
    const logGroupName = logGroupNameFor(workflowArn);
    const found = yield* logs.describeLogGroups({
      logGroupNamePrefix: logGroupName,
    });
    const exists = (found.logGroups ?? []).some(
      (group) => group.logGroupName === logGroupName,
    );
    if (exists) {
      return yield* Effect.fail(new LogGroupStillExists({ logGroupName }));
    }
  }).pipe(
    Effect.retry({
      while: (e): boolean => e._tag === "LogGroupStillExists",
      schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(5)]),
    }),
  );

// Crash-resilience sweep: if a run dies between createWorkflow and the
// provider delete, the auto-created log group (whose name embeds a
// service-assigned random suffix we cannot predict up front) would orphan.
// Reap every log group carrying this test's deterministic workflow-name
// prefixes so an interrupted run is cleaned up by the next one.
const TEST_LOG_GROUP_PREFIXES = [
  // engine-generated physical name for the `Etl` logical ID
  "/aws/mwaa-serverless/create-update-and-delete-a-workflow-Etl-",
  // explicit rename used by the replacement phase
  "/aws/mwaa-serverless/alchemy-mwaa-serverless-renamed-",
];

const reapTestLogGroups = Effect.gen(function* () {
  for (const prefix of TEST_LOG_GROUP_PREFIXES) {
    const found = yield* logs.describeLogGroups({
      logGroupNamePrefix: prefix,
    });
    for (const group of found.logGroups ?? []) {
      if (group.logGroupName !== undefined) {
        yield* logs
          .deleteLogGroup({ logGroupName: group.logGroupName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
      }
    }
  }
});

const assertWorkflowDeleted = (workflowArn: string) =>
  findWorkflow(workflowArn).pipe(
    Effect.flatMap((workflow) =>
      workflow === undefined || workflow.WorkflowStatus === "DELETING"
        ? Effect.void
        : Effect.fail(new WorkflowStillExists({ workflowArn })),
    ),
    Effect.retry({
      while: (e) => e._tag === "WorkflowStillExists",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update, and delete a workflow",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Phase 1 — the definition object must exist in S3 before the
      // workflow can be created, so deploy the bucket + role first and
      // upload the definition out-of-band.
      const infra = yield* stack.deploy(infrastructure);
      yield* s3.putObject({
        Bucket: infra.bucket.bucketName,
        Key: DEFINITION_KEY,
        Body: new TextEncoder().encode(
          workflowDefinition(infra.bucket.bucketName),
        ),
        ContentType: "application/yaml",
      });

      // Phase 2 — create the workflow.
      const { workflow } = yield* stack.deploy(
        workflowPhase("alchemy mwaa-serverless test workflow"),
      );

      expect(workflow.workflowArn).toContain(":workflow/");
      expect(workflow.name).toBeDefined();

      // Out-of-band verification via distilled.
      const observed = yield* mwaa.getWorkflow({
        WorkflowArn: workflow.workflowArn,
      });
      expect(observed.Name).toBe(workflow.name);
      expect(observed.RoleArn).toBeDefined();
      const tags = yield* mwaa.listTagsForResource({
        ResourceArn: workflow.workflowArn,
      });
      expect(tags.Tags?.fixture).toBe("mwaa-serverless-workflow");

      // Phase 3 — update mutable config (description) in place; the
      // workflow ARN must be stable across the update.
      const updated = yield* stack.deploy(
        workflowPhase("alchemy mwaa-serverless test workflow (updated)"),
      );
      expect(updated.workflow.workflowArn).toBe(workflow.workflowArn);
      const reobserved = yield* mwaa.getWorkflow({
        WorkflowArn: workflow.workflowArn,
      });
      expect(reobserved.Description).toBe(
        "alchemy mwaa-serverless test workflow (updated)",
      );

      // Phase 4 — changing the name is a replacement: a new workflow (new
      // ARN) is created and the old one deleted.
      const replaced = yield* stack.deploy(
        workflowPhase(
          "alchemy mwaa-serverless test workflow (replaced)",
          "alchemy-mwaa-serverless-renamed",
        ),
      );
      expect(replaced.workflow.workflowArn).not.toBe(workflow.workflowArn);
      expect(replaced.workflow.name).toBe("alchemy-mwaa-serverless-renamed");
      yield* assertWorkflowDeleted(workflow.workflowArn);
      // The replaced-away workflow's auto-created log group must be reaped
      // along with it, or every rename leaks a log group.
      yield* assertLogGroupDeleted(workflow.workflowArn);

      yield* stack.destroy();
      yield* assertWorkflowDeleted(replaced.workflow.workflowArn);
      yield* assertLogGroupDeleted(replaced.workflow.workflowArn);
    }).pipe(Effect.ensuring(Effect.orDie(reapTestLogGroups))),
  { timeout: 600_000 },
);
