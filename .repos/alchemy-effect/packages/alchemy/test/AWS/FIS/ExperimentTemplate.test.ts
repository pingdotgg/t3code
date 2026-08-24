import * as AWS from "@/AWS";
import { ExperimentTemplate } from "@/AWS/FIS";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as fis from "@distilled.cloud/aws/fis";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findTemplate = (id: string) =>
  fis.getExperimentTemplate({ id }).pipe(
    Effect.map((r) => r.experimentTemplate),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class TemplateStillExists extends Data.TaggedError("TemplateStillExists")<{
  readonly id: string;
}> {}

const assertTemplateDeleted = (id: string) =>
  findTemplate(id).pipe(
    Effect.flatMap((template) =>
      template === undefined
        ? Effect.void
        : Effect.fail(new TemplateStillExists({ id })),
    ),
    Effect.retry({
      while: (e) => e._tag === "TemplateStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

const fisRole = Effect.gen(function* () {
  return yield* Role("FisExperimentRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "fis.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    inlinePolicies: {
      "fis-ec2": {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "ec2:StopInstances",
              "ec2:StartInstances",
              "ec2:DescribeInstances",
            ],
            Resource: "*",
          },
        ],
      },
    },
  });
});

test.provider(
  "create, update definition + tags, delete experiment template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Definition only — no experiment is ever started, so nothing is
      // disrupted. The stop-instances action targets instances by a tag no
      // resource in this account carries.
      const template = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* fisRole;
          return yield* ExperimentTemplate("StopInstancesTemplate", {
            description: "alchemy fis test",
            roleArn: role.roleArn,
            targets: {
              Instances: {
                resourceType: "aws:ec2:instance",
                resourceTags: { "alchemy:fis-test": "true" },
                selectionMode: "COUNT(1)",
              },
            },
            actions: {
              StopInstances: {
                actionId: "aws:ec2:stop-instances",
                parameters: { startInstancesAfterDuration: "PT2M" },
                targets: { Instances: "Instances" },
              },
            },
            stopConditions: [{ source: "none" }],
            tags: { Environment: "test" },
          });
        }),
      );

      expect(template.id).toMatch(/^EXT/);
      expect(template.arn).toContain(":experiment-template/");
      expect(template.roleArn).toContain(":role/");

      // out-of-band verification via distilled — the template exists with
      // the exact definition we declared.
      const created = yield* findTemplate(template.id);
      expect(created).toBeDefined();
      expect(created?.description).toBe("alchemy fis test");
      expect(created?.roleArn).toBe(template.roleArn);
      expect(created?.stopConditions).toEqual([{ source: "none" }]);
      expect(created?.targets?.Instances?.resourceType).toBe(
        "aws:ec2:instance",
      );
      expect(created?.targets?.Instances?.selectionMode).toBe("COUNT(1)");
      expect(created?.targets?.Instances?.resourceTags).toEqual({
        "alchemy:fis-test": "true",
      });
      expect(created?.actions?.StopInstances?.actionId).toBe(
        "aws:ec2:stop-instances",
      );
      expect(created?.actions?.StopInstances?.parameters).toEqual({
        startInstancesAfterDuration: "PT2M",
      });
      expect(created?.tags?.Environment).toBe("test");
      expect(created?.tags?.["alchemy::id"]).toBe("StopInstancesTemplate");

      // update — new description, wider selection, an extra sequenced wait
      // action, and changed tags. Same physical template (stable id/arn).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* fisRole;
          return yield* ExperimentTemplate("StopInstancesTemplate", {
            description: "alchemy fis test updated",
            roleArn: role.roleArn,
            targets: {
              Instances: {
                resourceType: "aws:ec2:instance",
                resourceTags: { "alchemy:fis-test": "true" },
                selectionMode: "ALL",
              },
            },
            actions: {
              StopInstances: {
                actionId: "aws:ec2:stop-instances",
                parameters: { startInstancesAfterDuration: "PT2M" },
                targets: { Instances: "Instances" },
              },
              Wait: {
                actionId: "aws:fis:wait",
                parameters: { duration: "PT1M" },
                startAfter: ["StopInstances"],
              },
            },
            stopConditions: [{ source: "none" }],
            tags: { Environment: "test", Team: "chaos" },
          });
        }),
      );
      expect(updated.id).toBe(template.id);
      expect(updated.arn).toBe(template.arn);

      const afterUpdate = yield* findTemplate(template.id);
      expect(afterUpdate?.description).toBe("alchemy fis test updated");
      expect(afterUpdate?.targets?.Instances?.selectionMode).toBe("ALL");
      expect(afterUpdate?.actions?.Wait?.actionId).toBe("aws:fis:wait");
      expect(afterUpdate?.actions?.Wait?.startAfter).toEqual(["StopInstances"]);
      expect(afterUpdate?.tags?.Team).toBe("chaos");

      // removing the user tag converges (internal tags survive)
      yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* fisRole;
          return yield* ExperimentTemplate("StopInstancesTemplate", {
            description: "alchemy fis test updated",
            roleArn: role.roleArn,
            targets: {
              Instances: {
                resourceType: "aws:ec2:instance",
                resourceTags: { "alchemy:fis-test": "true" },
                selectionMode: "ALL",
              },
            },
            actions: {
              StopInstances: {
                actionId: "aws:ec2:stop-instances",
                parameters: { startInstancesAfterDuration: "PT2M" },
                targets: { Instances: "Instances" },
              },
              Wait: {
                actionId: "aws:fis:wait",
                parameters: { duration: "PT1M" },
                startAfter: ["StopInstances"],
              },
            },
            stopConditions: [{ source: "none" }],
            tags: { Environment: "test" },
          });
        }),
      );
      const afterTagRemoval = yield* findTemplate(template.id);
      expect(afterTagRemoval?.tags?.Team).toBeUndefined();
      expect(afterTagRemoval?.tags?.Environment).toBe("test");
      expect(afterTagRemoval?.tags?.["alchemy::id"]).toBe(
        "StopInstancesTemplate",
      );

      yield* stack.destroy();
      yield* assertTemplateDeleted(template.id);
    }),
  { timeout: 120_000 },
);

test.provider(
  "changing accountTargeting replaces the template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // A target-less wait action keeps the template valid under both
      // single-account and multi-account targeting.
      const waitTemplate = (
        accountTargeting?: "single-account" | "multi-account",
      ) =>
        Effect.gen(function* () {
          const role = yield* fisRole;
          return yield* ExperimentTemplate("WaitTemplate", {
            roleArn: role.roleArn,
            actions: {
              Wait: {
                actionId: "aws:fis:wait",
                parameters: { duration: "PT1M" },
              },
            },
            experimentOptions: accountTargeting
              ? { accountTargeting }
              : undefined,
          });
        });

      const first = yield* stack.deploy(waitTemplate());
      expect(first.id).toMatch(/^EXT/);
      // the description defaults to the logical id
      const observedFirst = yield* findTemplate(first.id);
      expect(observedFirst?.description).toBe("WaitTemplate");
      expect(observedFirst?.experimentOptions?.accountTargeting).toBe(
        "single-account",
      );

      // accountTargeting is create-only → replacement: new physical
      // template, old one deleted.
      const second = yield* stack.deploy(waitTemplate("multi-account"));
      expect(second.id).not.toBe(first.id);

      const observedSecond = yield* findTemplate(second.id);
      expect(observedSecond?.experimentOptions?.accountTargeting).toBe(
        "multi-account",
      );
      yield* assertTemplateDeleted(first.id);

      yield* stack.destroy();
      yield* assertTemplateDeleted(second.id);
    }),
  { timeout: 120_000 },
);
