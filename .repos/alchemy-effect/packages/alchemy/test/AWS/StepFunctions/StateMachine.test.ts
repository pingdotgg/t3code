import * as AWS from "@/AWS";
import { StateMachine } from "@/AWS/StepFunctions";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/aws/iam";
import * as sfn from "@distilled.cloud/aws/sfn";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const plain = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value);

class StateMachineStillExists extends Data.TaggedError(
  "StateMachineStillExists",
)<{ readonly stateMachineArn: string }> {}

// Deletion is asynchronous and slow — a machine stays visible in DELETING
// for minutes after deleteStateMachine returns. Deletion having been
// initiated (status DELETING) or completed (typed StateMachineDoesNotExist)
// both count as deleted; only an ACTIVE machine means destroy failed.
const assertStateMachineDeleted = (stateMachineArn: string) =>
  sfn.describeStateMachine({ stateMachineArn }).pipe(
    Effect.flatMap((machine) =>
      machine.status === "DELETING"
        ? Effect.void
        : Effect.fail(new StateMachineStillExists({ stateMachineArn })),
    ),
    Effect.catchTag("StateMachineDoesNotExist", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "StateMachineStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

class RoleStillExists extends Data.TaggedError("RoleStillExists")<{
  readonly roleName: string;
}> {}

const assertRoleDeleted = (roleName: string) =>
  iam.getRole({ RoleName: roleName }).pipe(
    Effect.flatMap(() => Effect.fail(new RoleStillExists({ roleName }))),
    Effect.catchTag("NoSuchEntityException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RoleStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const passDefinition = (comment: string) => ({
  Comment: comment,
  StartAt: "Done",
  States: {
    Done: { Type: "Pass", Result: { ok: true }, End: true },
  },
});

test.provider(
  "create, update definition, update tags, destroy STANDARD state machine",
  (stack) =>
    Effect.gen(function* () {
      const machine = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* StateMachine("Workflow", {
            definition: passDefinition("v1"),
            tags: { Environment: "test" },
          });
        }),
      );

      expect(machine.stateMachineArn).toContain(":stateMachine:");
      expect(machine.type).toBe("STANDARD");
      expect(machine.roleArn).toContain(":role/");
      expect(machine.roleName).toBeDefined();

      // out-of-band verification via distilled
      const created = yield* sfn.describeStateMachine({
        stateMachineArn: machine.stateMachineArn,
      });
      expect(created.type).toBe("STANDARD");
      expect(created.roleArn).toBe(machine.roleArn);
      expect(JSON.parse(plain(created.definition)).Comment).toBe("v1");

      const tags = yield* sfn.listTagsForResource({
        resourceArn: machine.stateMachineArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.tags ?? []).map((t) => [t.key, t.value]),
      );
      expect(tagRecord.Environment).toBe("test");
      expect(tagRecord["alchemy::id"]).toBe("Workflow");

      // update the definition and add a tag — same physical machine
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* StateMachine("Workflow", {
            definition: passDefinition("v2"),
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      expect(updated.stateMachineArn).toBe(machine.stateMachineArn);

      const afterUpdate = yield* sfn.describeStateMachine({
        stateMachineArn: machine.stateMachineArn,
      });
      expect(JSON.parse(plain(afterUpdate.definition)).Comment).toBe("v2");
      const revisionAfterUpdate = afterUpdate.revisionId;

      const afterUpdateTags = yield* sfn.listTagsForResource({
        resourceArn: machine.stateMachineArn,
      });
      expect(
        Object.fromEntries(
          (afterUpdateTags.tags ?? []).map((t) => [t.key, t.value]),
        ).Extra,
      ).toBe("1");

      // no-op deploy converges without creating a new revision
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* StateMachine("Workflow", {
            definition: passDefinition("v2"),
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      const afterNoop = yield* sfn.describeStateMachine({
        stateMachineArn: machine.stateMachineArn,
      });
      expect(afterNoop.revisionId).toBe(revisionAfterUpdate);

      // remove a tag
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* StateMachine("Workflow", {
            definition: passDefinition("v2"),
            tags: { Environment: "test" },
          });
        }),
      );
      const afterTagRemoval = yield* sfn.listTagsForResource({
        resourceArn: machine.stateMachineArn,
      });
      const remaining = Object.fromEntries(
        (afterTagRemoval.tags ?? []).map((t) => [t.key, t.value]),
      );
      expect(remaining.Extra).toBeUndefined();
      expect(remaining.Environment).toBe("test");

      yield* stack.destroy();
      yield* assertStateMachineDeleted(machine.stateMachineArn);
      yield* assertRoleDeleted(machine.roleName!);
    }),
  { timeout: 120_000 },
);

test.provider(
  "EXPRESS workflow with tracing; type change triggers replacement",
  (stack) =>
    Effect.gen(function* () {
      const express = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* StateMachine("TypedWorkflow", {
            type: "EXPRESS",
            tracingEnabled: true,
            definition: passDefinition("express"),
          });
        }),
      );
      expect(express.type).toBe("EXPRESS");

      const observed = yield* sfn.describeStateMachine({
        stateMachineArn: express.stateMachineArn,
      });
      expect(observed.type).toBe("EXPRESS");
      expect(observed.tracingConfiguration?.enabled).toBe(true);

      // changing the type replaces the machine (new instance id => new name)
      const standard = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* StateMachine("TypedWorkflow", {
            type: "STANDARD",
            definition: passDefinition("standard"),
          });
        }),
      );
      expect(standard.type).toBe("STANDARD");
      expect(standard.stateMachineArn).not.toBe(express.stateMachineArn);

      const observedStandard = yield* sfn.describeStateMachine({
        stateMachineArn: standard.stateMachineArn,
      });
      expect(observedStandard.type).toBe("STANDARD");
      yield* assertStateMachineDeleted(express.stateMachineArn);

      yield* stack.destroy();
      yield* assertStateMachineDeleted(standard.stateMachineArn);
    }),
  { timeout: 120_000 },
);

test.provider(
  "string definition with substitutions",
  (stack) =>
    Effect.gen(function* () {
      const machine = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* StateMachine("TemplatedWorkflow", {
            definition: JSON.stringify({
              Comment: "${comment}",
              StartAt: "Done",
              States: { Done: { Type: "Pass", End: true } },
            }),
            definitionSubstitutions: { comment: "substituted-value" },
          });
        }),
      );

      const observed = yield* sfn.describeStateMachine({
        stateMachineArn: machine.stateMachineArn,
      });
      expect(JSON.parse(plain(observed.definition)).Comment).toBe(
        "substituted-value",
      );

      yield* stack.destroy();
      yield* assertStateMachineDeleted(machine.stateMachineArn);
    }),
  { timeout: 120_000 },
);
