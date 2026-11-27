import * as AWS from "@alchemy.run/aws";
import { Repository } from "@alchemy.run/aws/ECR/Repository";
import type { PolicyDocument } from "@alchemy.run/aws/IAM/Policy";
import { normalizePolicyDocument } from "@alchemy.run/aws/IAM/Policy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { driftOf, repairDrift, waitForDrift } from "../drift.ts";

const { test } = Test.make({ providers: AWS.providers() });

class RepositoryStillExists extends Data.TaggedError("RepositoryStillExists") {}

// Out-of-band proof that the trailing destroy actually removed the
// repository: describeRepositories must settle on the typed
// RepositoryNotFoundException.
const assertRepositoryDeleted = Effect.fn(function* (repositoryName: string) {
  yield* ecr.describeRepositories({ repositoryNames: [repositoryName] }).pipe(
    Effect.flatMap(() => Effect.fail(new RepositoryStillExists())),
    Effect.retry({
      while: (e) => e._tag === "RepositoryStillExists",
      schedule: Schedule.max([Schedule.exponential(250), Schedule.recurs(8)]),
    }),
    Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
  );
});

// Canonical `list()` test (AWS account/region-scoped collection): deploy a real
// repository, resolve the provider from context via the typed `findProvider`,
// call `list()`, and assert the deployed repository appears in the
// exhaustively-paginated result.
test.provider(
  "list enumerates the deployed repository",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("ListRepository", {
            repositoryName: "alchemy-test-ecr-repo-list",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Repository);
      const all = yield* provider.list();

      expect(all.some((r) => r.repositoryName === repo.repositoryName)).toBe(true);

      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
  { tags: ["provider:aws", "provider:aws:ecr", "live"] },
);

test.provider(
  "reconciles tag mutability and scan-on-push on an existing repository",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployRepository = (imageTagMutability: "MUTABLE" | "IMMUTABLE", scanOnPush: boolean) =>
        stack.deploy(
          Repository("SettingsRepository", {
            repositoryName: "alchemy-test-ecr-repo-settings",
            imageTagMutability,
            scanOnPush,
          }),
        );

      yield* deployRepository("MUTABLE", false);
      const updated = yield* deployRepository("IMMUTABLE", true);

      const described = yield* ecr.describeRepositories({
        repositoryNames: [updated.repositoryName],
      });
      const observed = described.repositories?.[0];
      expect(observed?.imageTagMutability).toBe("IMMUTABLE");
      expect(observed?.imageScanningConfiguration?.scanOnPush).toBe(true);
      expect(updated.imageTagMutability).toBe("IMMUTABLE");
      expect(updated.scanOnPush).toBe(true);

      yield* stack.destroy();
      yield* assertRepositoryDeleted(updated.repositoryName);
    }),
  { tags: ["provider:aws", "provider:aws:ecr", "live"], timeout: 120_000 },
);

const repositoryPolicy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "LambdaECRImageRetrieval",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
    },
  ],
};

const readRepositoryPolicy = (repositoryName: string) =>
  ecr.getRepositoryPolicy({ repositoryName }).pipe(
    Effect.map((response) => response.policyText),
    Effect.catchTag("RepositoryPolicyNotFoundException", () => Effect.succeed(undefined)),
  );

test.provider(
  "PolicyDocument-valued policy deploys and re-deploys clean",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployWithPolicy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Repository("PolicyRepository", {
              repositoryName: "alchemy-test-ecr-repo-policy",
              policy: repositoryPolicy,
            });
          }),
        );

      const repo = yield* deployWithPolicy();
      expect(repo.policy).toBeDefined();

      // Out-of-band: the applied policy is equivalent to the structured
      // document (normalized comparison — key order / whitespace agnostic).
      const observed = yield* readRepositoryPolicy(repo.repositoryName);
      expect(observed).toBeDefined();
      expect(normalizePolicyDocument(observed!)).toBe(normalizePolicyDocument(repositoryPolicy));

      // Re-deploy the identical PolicyDocument — must converge cleanly (the
      // provider diffs normalized observed vs desired and no-ops the set).
      const again = yield* deployWithPolicy();
      expect(again.repositoryArn).toBe(repo.repositoryArn);
      const observedAgain = yield* readRepositoryPolicy(repo.repositoryName);
      expect(normalizePolicyDocument(observedAgain!)).toBe(
        normalizePolicyDocument(repositoryPolicy),
      );

      // Removing the prop deletes the repository policy.
      const removed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Repository("PolicyRepository", {
            repositoryName: "alchemy-test-ecr-repo-policy",
          });
        }),
      );
      expect(removed.policy).toBeUndefined();
      expect(yield* readRepositoryPolicy(repo.repositoryName)).toBeUndefined();

      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
  { tags: ["provider:aws", "provider:aws:ecr", "provider:aws:iam", "live"], timeout: 120_000 },
);

// #2688: `read` must observe the live lifecycle policy and tags, not carry
// the persisted ones.
test.provider(
  "drift detects and repairs out-of-band lifecycle policy and tags",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const policy = (count: number) =>
        JSON.stringify({
          rules: [
            {
              rulePriority: 1,
              selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: count },
              action: { type: "expire" },
            },
          ],
        });
      const repo = yield* stack.deploy(
        Repository("DriftRepo", {
          lifecyclePolicyText: policy(10),
          tags: { team: "declared" },
        }),
      );
      expect((yield* driftOf(stack, "DriftRepo"))?.action).toBe("unchanged");

      yield* ecr.putLifecyclePolicy({
        repositoryName: repo.repositoryName,
        lifecyclePolicyText: policy(99),
      });
      yield* ecr.tagResource({
        resourceArn: repo.repositoryArn,
        tags: [{ Key: "team", Value: "out-of-band" }],
      });

      const drifted = yield* waitForDrift(stack, "DriftRepo", "drifted");
      expect(drifted?.attr?.lifecyclePolicyText).toContain("99");
      expect(drifted?.attr?.tags?.team).toBe("out-of-band");

      const repaired = yield* repairDrift(stack);
      expect(repaired.resources.DriftRepo?.action).toBe("repaired");
      expect((yield* driftOf(stack, "DriftRepo"))?.action).toBe("unchanged");
      const lifecycle = yield* ecr.getLifecyclePolicy({ repositoryName: repo.repositoryName });
      expect(lifecycle.lifecyclePolicyText).toContain('"countNumber":10');

      yield* stack.destroy();
      yield* assertRepositoryDeleted(repo.repositoryName);
    }),
  { tags: ["provider:aws", "provider:aws:ecr", "live"], timeout: 120_000 },
);
