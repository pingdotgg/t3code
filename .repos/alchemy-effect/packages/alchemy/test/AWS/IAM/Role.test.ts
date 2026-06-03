import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const assumeRolePolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: {
        Service: "lambda.amazonaws.com",
      },
      Action: ["sts:AssumeRole"],
    },
  ],
};

test.provider("create, update, and delete role", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const role = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Role("IamRole", {
          assumeRolePolicyDocument: assumeRolePolicy,
          managedPolicyArns: [
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
          inlinePolicies: {
            AllowLogs: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogGroup"],
                  Resource: "*",
                },
              ],
            },
          },
          tags: {
            env: "test",
          },
        });
      }),
    );

    const created = yield* IAM.getRole({
      RoleName: role.roleName,
    });
    expect(created.Role.RoleName).toBe(role.roleName);

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Role("IamRole", {
          assumeRolePolicyDocument: assumeRolePolicy,
          managedPolicyArns: [],
          inlinePolicies: {
            AllowLogs: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogStream"],
                  Resource: "*",
                },
              ],
            },
          },
          tags: {
            env: "prod",
          },
        });
      }),
    );

    const updatedTags = yield* IAM.listRoleTags({
      RoleName: role.roleName,
    });
    expect(
      Object.fromEntries(
        (updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
      ),
    ).toMatchObject({
      env: "prod",
    });

    yield* stack.destroy();

    const deleted = yield* IAM.getRole({
      RoleName: role.roleName,
    }).pipe(Effect.option);
    expect(deleted._tag).toBe("None");
  }),
);

// Engine-level adoption tests for IAM Role. Note: the user must supply an
// explicit `roleName` for adoption to work across a state-store wipe —
// without one, `createPhysicalName` derives a fresh name from a per-deploy
// random `instanceId`, so the cold-start `read` lookup would never find
// the original role.
test.provider(
  "owned role (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const roleName = `alchemy-test-role-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("AdoptableRole", {
            roleName,
            assumeRolePolicyDocument: assumeRolePolicy,
          });
        }),
      );

      // Wipe state — the role stays in IAM.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableRole",
        });
      }).pipe(Effect.provide(stack.state));

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("AdoptableRole", {
            roleName,
            assumeRolePolicyDocument: assumeRolePolicy,
          });
        }),
      );

      expect(adopted.roleArn).toEqual(initial.roleArn);
      expect(adopted.roleName).toEqual(roleName);

      yield* stack.destroy();

      const deleted = yield* IAM.getRole({ RoleName: roleName }).pipe(
        Effect.option,
      );
      expect(deleted._tag).toBe("None");
    }),
);

test.provider(
  "foreign-tagged role requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Use a deterministic shared physical name for both deploys.
      const sharedRoleName = `alchemy-test-role-takeover-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      const original = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("Original", {
            roleName: sharedRoleName,
            assumeRolePolicyDocument: assumeRolePolicy,
          });
        }),
      );

      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "Original",
        });
      }).pipe(Effect.provide(stack.state));

      const takenOver = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Role("Different", {
              roleName: sharedRoleName,
              assumeRolePolicyDocument: assumeRolePolicy,
            });
          }),
        )
        .pipe(adopt(true));

      expect(takenOver.roleArn).toEqual(original.roleArn);

      // After adoption, tags should now identify this stack/stage/id.
      const tagsResp = yield* IAM.listRoleTags({ RoleName: sharedRoleName });
      const tagMap = Object.fromEntries(
        (tagsResp.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagMap["alchemy::id"]).toEqual("Different");

      yield* stack.destroy();

      const deleted = yield* IAM.getRole({ RoleName: sharedRoleName }).pipe(
        Effect.option,
      );
      expect(deleted._tag).toBe("None");
    }),
);
