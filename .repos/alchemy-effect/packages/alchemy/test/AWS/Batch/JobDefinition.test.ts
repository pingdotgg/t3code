import * as AWS from "@/AWS";
import { JobDefinition } from "@/AWS/Batch/JobDefinition.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as batch from "@distilled.cloud/aws/batch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const name = "alchemy-test-batch-jobdef";

const activeRevisions = batch.describeJobDefinitions
  .pages({ jobDefinitionName: name, status: "ACTIVE" })
  .pipe(
    Stream.runCollect,
    Effect.map((pages) =>
      Array.from(pages).flatMap((p) => p.jobDefinitions ?? []),
    ),
  );

const jobDef = (command: string[]) =>
  Effect.gen(function* () {
    const executionRole = yield* Role("JobDefExecutionRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
      ],
    });
    return yield* JobDefinition("EchoJobDef", {
      jobDefinitionName: name,
      image: "public.ecr.aws/docker/library/busybox:latest",
      command,
      executionRoleArn: executionRole.roleArn,
    });
  });

test.provider(
  "revision semantics: register, no-op redeploy, revise, deregister all",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Register revision 1.
      const created = yield* stack.deploy(jobDef(["echo", "one"]));
      expect(created.jobDefinitionName).toBe(name);
      const firstRevision = created.revision;
      expect(firstRevision).toBeGreaterThanOrEqual(1);
      expect(created.jobDefinitionArn).toContain(
        `job-definition/${name}:${firstRevision}`,
      );

      // Identical content — no new revision registered.
      const unchanged = yield* stack.deploy(jobDef(["echo", "one"]));
      expect(unchanged.revision).toBe(firstRevision);
      expect(yield* activeRevisions).toHaveLength(1);

      // Changed command — a new immutable revision under the same family.
      const revised = yield* stack.deploy(jobDef(["echo", "two"]));
      expect(revised.revision).toBe(firstRevision + 1);
      const revisions = yield* activeRevisions;
      expect(revisions).toHaveLength(2);
      const latest = revisions.find((d) => d.revision === revised.revision);
      expect(latest?.containerProperties?.command).toEqual(["echo", "two"]);
      expect(latest?.containerProperties?.resourceRequirements).toEqual(
        expect.arrayContaining([
          { type: "VCPU", value: "0.25" },
          { type: "MEMORY", value: "512" },
        ]),
      );

      // Destroy — EVERY active revision of the family is deregistered.
      yield* stack.destroy();
      expect(yield* activeRevisions).toHaveLength(0);
    }),
  { timeout: 240_000 },
);
