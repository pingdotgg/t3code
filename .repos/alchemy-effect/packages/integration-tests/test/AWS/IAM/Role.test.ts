import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { Role } from "@alchemy.run/aws/IAM";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import type { ResolvedCredentials } from "@distilled.cloud/aws/Credentials";
import * as IAM from "@distilled.cloud/aws/iam";
import * as STS from "@distilled.cloud/aws/sts";
import { adopt } from "alchemy/AdoptPolicy";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assumeRolePolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "lambda.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

test.provider(
  "create, update, and delete role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const role = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("IamRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
            maxSessionDuration: "2 hours",
            managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
            inlinePolicies: {
              AllowLogs: {
                Version: "2012-10-17",
                Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup"], Resource: "*" }],
              },
            },
            tags: { env: "test" },
          });
        }),
      );

      const created = yield* IAM.getRole({ RoleName: role.roleName });
      expect(created.Role.RoleName).toBe(role.roleName);
      // Duration.Input prop converts to whole wire seconds.
      expect(created.Role.MaxSessionDuration).toBe(7200);

      // #1968: IAM stores `["sts:AssumeRole"]` as `"sts:AssumeRole"`; an
      // equivalent document is not drift.
      const clean = yield* Drift.detect({ name: stack.name, stage: stack.stage }).pipe(
        Effect.provide(stack.state),
      );
      expect(clean.resources.IamRole?.action).toBe("unchanged");

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("IamRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
            maxSessionDuration: "1 hour",
            managedPolicyArns: [],
            inlinePolicies: {
              AllowLogs: {
                Version: "2012-10-17",
                Statement: [{ Effect: "Allow", Action: ["logs:CreateLogStream"], Resource: "*" }],
              },
            },
            tags: { env: "prod" },
          });
        }),
      );

      const updatedTags = yield* IAM.listRoleTags({ RoleName: role.roleName });
      expect(
        Object.fromEntries((updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value])),
      ).toMatchObject({ env: "prod" });

      // The reconcile sync path applies the changed Duration prop.
      const updated = yield* IAM.getRole({ RoleName: role.roleName });
      expect(updated.Role.MaxSessionDuration).toBe(3600);

      yield* stack.destroy();

      const deleted = yield* IAM.getRole({ RoleName: role.roleName }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);

test.provider(
  "does not rewrite an inline policy IAM stores in an equivalent form",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployRole = (tags: Record<string, string>) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Role("EquivalentInlineRole", {
              assumeRolePolicyDocument: assumeRolePolicy,
              inlinePolicies: {
                AllowLogs: {
                  Version: "2012-10-17",
                  Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup"], Resource: "*" }],
                },
              },
              tags,
            });
          }),
        );

      const role = yield* deployRole({ env: "test" });

      // Store an equivalent document in a different form: reordered keys and
      // a single-item list as a scalar.
      const equivalent = JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Resource: "*", Action: "logs:CreateLogGroup", Effect: "Allow" }],
      });
      yield* IAM.putRolePolicy({
        RoleName: role.roleName,
        PolicyName: "AllowLogs",
        PolicyDocument: equivalent,
      });

      // A tags-only change runs reconcile, which must leave the policy alone.
      yield* deployRole({ env: "prod" });

      const observed = yield* IAM.getRolePolicy({
        RoleName: role.roleName,
        PolicyName: "AllowLogs",
      });
      expect(JSON.parse(decodeURIComponent(observed.PolicyDocument))).toEqual(
        JSON.parse(equivalent),
      );

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);

// Credentials the next deploy runs as; unset means the testing profile.
let deployAs: ResolvedCredentials | undefined;

const deployAsEnvironment = Layer.effect(
  AWSEnvironment,
  Effect.gen(function* () {
    const profile = yield* AWSEnvironment;
    return Effect.map(profile, (environment) => ({
      ...environment,
      credentials: Effect.suspend(() =>
        deployAs ? Effect.succeed(deployAs) : environment.credentials,
      ),
    }));
  }),
).pipe(Layer.provide(AWS.providers()));

const deployAsRole = Test.make({
  providers: AWS.providers().pipe(Layer.provide(deployAsEnvironment)),
});

deployAsRole.test.provider(
  "a role denied rewriting its own policies can deploy a change to itself",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId, region } = yield* AWSEnvironment.current;
      const deployRole = (tags: Record<string, string>) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Role("SelfDeployingRole", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { AWS: `arn:aws:iam::${accountId}:root` },
                    Action: ["sts:AssumeRole"],
                  },
                ],
              },
              inlinePolicies: {
                Deploy: {
                  Version: "2012-10-17",
                  Statement: [
                    { Effect: "Allow", Action: ["*"], Resource: "*" },
                    {
                      Effect: "Deny",
                      Action: ["iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy"],
                      Resource: "*",
                    },
                  ],
                },
              },
              tags,
            });
          }),
        );

      const role = yield* deployRole({ env: "test" });

      // A freshly created role's trust policy takes a few seconds to apply.
      const assumed = yield* STS.assumeRole({
        RoleArn: role.roleArn,
        RoleSessionName: "alchemy-self-deploy",
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "AccessDeniedException",
          schedule: Schedule.exponential("1 second"),
          times: 8,
        }),
      );
      deployAs = {
        accessKeyId: Redacted.make(assumed.Credentials!.AccessKeyId),
        secretAccessKey: Redacted.isRedacted(assumed.Credentials!.SecretAccessKey)
          ? assumed.Credentials!.SecretAccessKey
          : Redacted.make(assumed.Credentials!.SecretAccessKey),
        sessionToken: Redacted.make(assumed.Credentials!.SessionToken),
        region,
        expiration: assumed.Credentials!.Expiration?.getTime(),
      };

      // As the role itself, change only its tags. Reconcile must not call
      // UpdateAssumeRolePolicy or PutRolePolicy for unchanged documents
      // that IAM returns in its own form.
      yield* deployRole({ env: "prod" }).pipe(
        Effect.ensuring(Effect.sync(() => (deployAs = undefined))),
      );

      const tags = yield* IAM.listRoleTags({ RoleName: role.roleName });
      expect(
        Object.fromEntries((tags.Tags ?? []).map((tag) => [tag.Key, tag.Value])),
      ).toMatchObject({ env: "prod" });

      yield* stack.destroy();
    }).pipe(Effect.ensuring(Effect.sync(() => (deployAs = undefined)))),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
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
          const role = yield* Role("BoundRole", { assumeRolePolicyDocument: assumeRolePolicy });
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
          return yield* Role("BoundRole", { assumeRolePolicyDocument: assumeRolePolicy });
        }),
      );

      const afterUnbind = yield* IAM.getRolePolicy({
        RoleName: role.roleName,
        PolicyName: "alchemy-bindings",
      }).pipe(Effect.option);
      expect(afterUnbind._tag).toBe("None");

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);

test.provider(
  "bindings can supply the role's trust policy",
  (stack) =>
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
      const trust = JSON.parse(decodeURIComponent(live.Role.AssumeRolePolicyDocument!)) as {
        Statement: Array<{ Principal?: { Service?: string } }>;
      };
      expect(trust.Statement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Principal: { Service: "lambda.amazonaws.com" } }),
        ]),
      );

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);

test.provider(
  "list enumerates the deployed role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const role = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Role("ListRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
            tags: { env: "test" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Role);
      const all = yield* provider.list();

      const found = all.find((r) => r.roleName === role.roleName);
      expect(found).toBeDefined();
      expect(found?.roleArn).toBe(role.roleArn);

      yield* stack.destroy();

      const deleted = yield* IAM.getRole({ RoleName: role.roleName }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
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
        yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "AdoptableRole" });
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

      const deleted = yield* IAM.getRole({ RoleName: roleName }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }).pipe(Effect.ensuring(deleteRoleIfExists("alchemy-test-role-adopt"))),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
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
        yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "Original" });
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
      const tagMap = Object.fromEntries((tagsResp.Tags ?? []).map((t) => [t.Key, t.Value]));
      expect(tagMap["alchemy::id"]).toEqual("Different");

      yield* stack.destroy();

      const deleted = yield* IAM.getRole({ RoleName: sharedRoleName }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }).pipe(Effect.ensuring(deleteRoleIfExists("alchemy-test-role-takeover"))),
  { tags: ["provider:aws", "provider:aws:iam", "live"] },
);
