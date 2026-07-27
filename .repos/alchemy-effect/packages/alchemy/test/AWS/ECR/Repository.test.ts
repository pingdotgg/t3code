import * as AWS from "@/AWS";
import { Repository } from "@/AWS/ECR/Repository.ts";
import type { PolicyDocument } from "@/AWS/IAM/Policy.ts";
import { normalizePolicyDocument } from "@/AWS/IAM/Policy.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ecr from "@distilled.cloud/aws/ecr";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

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
test.provider("list enumerates the deployed repository", (stack) =>
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

    expect(all.some((r) => r.repositoryName === repo.repositoryName)).toBe(
      true,
    );

    yield* stack.destroy();
    yield* assertRepositoryDeleted(repo.repositoryName);
  }),
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
    Effect.catchTag("RepositoryPolicyNotFoundException", () =>
      Effect.succeed(undefined),
    ),
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
      expect(normalizePolicyDocument(observed!)).toBe(
        normalizePolicyDocument(repositoryPolicy),
      );

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
  { timeout: 120_000 },
);
