import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
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
          maxSessionDuration: "2 hours",
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
    // Duration.Input prop converts to whole wire seconds.
    expect(created.Role.MaxSessionDuration).toBe(7200);

    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Role("IamRole", {
          assumeRolePolicyDocument: assumeRolePolicy,
          maxSessionDuration: "1 hour",
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

    // The reconcile sync path applies the changed Duration prop.
    const updated = yield* IAM.getRole({ RoleName: role.roleName });
    expect(updated.Role.MaxSessionDuration).toBe(3600);

    yield* stack.destroy();

    const deleted = yield* IAM.getRole({
      RoleName: role.roleName,
    }).pipe(Effect.option);
    expect(deleted._tag).toBe("None");
  }),
);

test.provider(
  "folds binding-supplied policy statements into an inline policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Phase 1: a consumer binds policy statements to the role; the provider
      // folds them into the synthesized `alchemy-bindings` inline policy.
      const role = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* Role("BoundRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
          });
          yield* role.bind`Allow(test, s3:GetObject)`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["s3:GetObject"],
                Resource: ["arn:aws:s3:::example-bucket/*"],
              },
            ],
          });
          return role;
        }),
      );

      const bound = yield* IAM.getRolePolicy({
        RoleName: role.roleName,
        PolicyName: "alchemy-bindings",
      });
      const boundDoc = JSON.parse(decodeURIComponent(bound.PolicyDocument)) as {
        Statement: Array<{ Action: string[]; Resource: string[] }>;
      };
      expect(boundDoc.Statement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Action: ["s3:GetObject"],
            Resource: ["arn:aws:s3:::example-bucket/*"],
          }),
        ]),
      );

      // Phase 2: re-deploy without the binding; the inline policy is removed.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("BoundRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
          });
        }),
      );

      const afterUnbind = yield* IAM.getRolePolicy({
        RoleName: role.roleName,
        PolicyName: "alchemy-bindings",
      }).pipe(Effect.option);
      expect(afterUnbind._tag).toBe("None");

      yield* stack.destroy();
    }),
);

test.provider("bindings can supply the role's trust policy", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    // A bare role with no `assumeRolePolicyDocument`; the binding supplies the
    // trust statement instead.
    const role = yield* stack.deploy(
      Effect.gen(function* () {
        const role = yield* Role("TrustBoundRole", {});
        yield* role.bind`Trust(test, lambda)`({
          assumeRolePolicyStatements: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: ["sts:AssumeRole"],
            },
          ],
        });
        return role;
      }),
    );

    const live = yield* IAM.getRole({ RoleName: role.roleName });
    const trust = JSON.parse(
      decodeURIComponent(live.Role.AssumeRolePolicyDocument!),
    ) as { Statement: Array<{ Principal?: { Service?: string } }> };
    expect(trust.Statement).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Principal: { Service: "lambda.amazonaws.com" },
        }),
      ]),
    );

    yield* stack.destroy();
  }),
);

test.provider("list enumerates the deployed role", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const role = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Role("ListRole", {
          assumeRolePolicyDocument: assumeRolePolicy,
          tags: {
            env: "test",
          },
        });
      }),
    );

    const provider = yield* Provider.findProvider(Role);
    const all = yield* provider.list();

    const found = all.find((r) => r.roleName === role.roleName);
    expect(found).toBeDefined();
    expect(found?.roleArn).toBe(role.roleArn);

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
//
// These tests wipe the state store mid-test, so the framework's automatic
// scratch-stack teardown cannot always see the role. Each test therefore
// uses a DETERMINISTIC role name, pre-cleans any leftover from a previously
// killed run, and guarantees an idempotent out-of-band delete via
// `Effect.ensuring` so a pass (or interruption) never orphans the role.
const deleteRoleIfExists = (roleName: string) =>
  IAM.deleteRole({ RoleName: roleName }).pipe(
    Effect.catchTag("NoSuchEntityException", () => Effect.void),
    Effect.asVoid,
    // Any non-not-found failure is a real cleanup bug — surface it loudly.
    Effect.orDie,
  );

test.provider(
  "owned role (matching alchemy tags) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const roleName = "alchemy-test-role-adopt";

      // Reclaim a leftover from a previously killed run.
      yield* deleteRoleIfExists(roleName);

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
    }).pipe(Effect.ensuring(deleteRoleIfExists("alchemy-test-role-adopt"))),
);

test.provider(
  "foreign-tagged role requires adopt(true) to take over",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Use a deterministic shared physical name for both deploys.
      const sharedRoleName = "alchemy-test-role-takeover";

      // Reclaim a leftover from a previously killed run.
      yield* deleteRoleIfExists(sharedRoleName);

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
    }).pipe(Effect.ensuring(deleteRoleIfExists("alchemy-test-role-takeover"))),
);
