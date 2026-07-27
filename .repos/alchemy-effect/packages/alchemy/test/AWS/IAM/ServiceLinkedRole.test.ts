import * as AWS from "@/AWS";
import { ServiceLinkedRole } from "@/AWS/IAM";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// The deletion task can report SUCCEEDED slightly before `getRole` stops
// returning the role — poll (bounded) until IAM catches up.
const waitUntilRoleGone = (roleName: string) =>
  IAM.getRole({ RoleName: roleName }).pipe(
    Effect.option,
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (result) => result._tag === "None",
      times: 15,
    }),
  );

// Auto Scaling supports custom suffixes and deletes cleanly when no Auto
// Scaling groups reference the role — the canonical safely-testable SLR.
// Suffixes keep these tests away from the account's shared (unsuffixed)
// AWSServiceRoleForAutoScaling, which other infrastructure may depend on.
const testServiceName = "autoscaling.amazonaws.com";
const testSuffix = "AlchemyTest";
const testAdoptSuffix = "AlchemyAdopt";
// Deterministic physical name of the out-of-band SLR the adoption test
// creates: Auto Scaling names suffixed SLRs `AWSServiceRoleForAutoScaling_
// {suffix}`.
const adoptRoleName = `AWSServiceRoleForAutoScaling_${testAdoptSuffix}`;

// Idempotent out-of-band cleanup for the adoption SLR — safe when the stack
// already deleted it (or it never fully created). Submits the async deletion
// task and tolerates not-found.
const deleteAdoptRoleIfExists = IAM.deleteServiceLinkedRole({
  RoleName: adoptRoleName,
}).pipe(
  Effect.catchTag("NoSuchEntityException", () =>
    Effect.succeed({ DeletionTaskId: "" }),
  ),
  Effect.asVoid,
  // Any non-not-found failure is a real cleanup bug — surface it loudly.
  Effect.orDie,
);

describe("AWS.IAM.ServiceLinkedRole", () => {
  test.provider(
    "create, update description, and delete a service-linked role",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployRole = (description: string) =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* ServiceLinkedRole("AutoScalingSLR", {
                awsServiceName: testServiceName,
                customSuffix: testSuffix,
                description,
              });
            }),
          );

        const created = yield* deployRole("alchemy service-linked role test");

        expect(created.roleName.endsWith(`_${testSuffix}`)).toBe(true);
        expect(created.awsServiceName).toBe(testServiceName);
        expect(created.customSuffix).toBe(testSuffix);

        // Out-of-band: the role exists under the service's deterministic path.
        const observed = yield* IAM.getRole({ RoleName: created.roleName });
        expect(observed.Role?.Path).toBe(
          `/aws-service-role/${testServiceName}/`,
        );
        expect(observed.Role?.Arn).toBe(created.roleArn);
        expect(observed.Role?.Description).toBe(
          "alchemy service-linked role test",
        );

        // Update — the description is the only mutable aspect of an SLR.
        const updated = yield* deployRole("alchemy SLR updated description");
        expect(updated.roleArn).toBe(created.roleArn);

        const afterUpdate = yield* IAM.getRole({
          RoleName: created.roleName,
        });
        expect(afterUpdate.Role?.Description).toBe(
          "alchemy SLR updated description",
        );

        // Destroy — the provider waits for the async deletion task; give
        // getRole a bounded window to observe the removal.
        yield* stack.destroy();

        const deleted = yield* waitUntilRoleGone(created.roleName);
        expect(deleted._tag).toBe("None");
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "adopts a service-linked role that already exists",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Pre-create the role out-of-band, simulating a service-created (or
        // operator-created) SLR that predates the stack.
        const preexisting = yield* IAM.createServiceLinkedRole({
          AWSServiceName: testServiceName,
          CustomSuffix: testAdoptSuffix,
        }).pipe(
          // Idempotence across re-runs: an earlier interrupted run may have
          // left the role behind — the create then reports InvalidInput.
          Effect.catchTag("InvalidInputException", () =>
            Effect.succeed({ Role: undefined }),
          ),
        );

        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* ServiceLinkedRole("AdoptedSLR", {
              awsServiceName: testServiceName,
              customSuffix: testAdoptSuffix,
            });
          }),
        );

        expect(adopted.roleName.endsWith(`_${testAdoptSuffix}`)).toBe(true);
        if (preexisting.Role) {
          expect(adopted.roleArn).toBe(preexisting.Role.Arn);
        }

        // Destroy deletes the adopted role (deletion awaited by the provider).
        yield* stack.destroy();

        const deleted = yield* waitUntilRoleGone(adopted.roleName);
        expect(deleted._tag).toBe("None");
      }).pipe(
        // The role is created out-of-band, so the scratch stack only cleans
        // it once the deploy adopts it. Guarantee deletion on failure or
        // interruption in the window between create and adoption.
        Effect.ensuring(deleteAdoptRoleIfExists),
      ),
    { timeout: 120_000 },
  );
});
