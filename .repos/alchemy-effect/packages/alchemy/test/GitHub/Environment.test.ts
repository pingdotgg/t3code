import * as GitHub from "@/GitHub";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GitHub.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// These tests create, mutate, and delete a real deployment environment, so
// they run against the dedicated test org (never a real one). Set
// GITHUB_TEST_OWNER="" to skip. The host repository is public because
// environments (and their protection rules) on private repositories are
// plan-gated.
const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
const repo =
  process.env.GITHUB_TEST_ENVIRONMENT_REPOSITORY ??
  "alchemy-effect-environment-test";

// Derive the repository name from the `fullName` output — referencing an
// output (rather than the `repo` constant) makes the engine order dependent
// resources after the repository exists.
const repoName = (repository: GitHub.Repository) =>
  Output.map(repository.fullName, (fullName) => fullName.split("/")[1]!);

const getEnvironment = (name: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          const { data } = await octokit.rest.repos.getEnvironment({
            owner,
            repo,
            environment_name: name,
          });
          return data;
        } catch (error: any) {
          if (error.status === 404) return undefined;
          throw error;
        }
      },
      catch: (e) => e as Error,
    });
  });

const listBranchPolicies = (name: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: async () => {
        const { data } = await octokit.rest.repos.listDeploymentBranchPolicies({
          owner,
          repo,
          environment_name: name,
          per_page: 100,
        });
        return (data.branch_policies ?? []).map((policy) => policy.name);
      },
      catch: (e) => e as Error,
    });
  });

test.provider.skipIf(!owner)(
  "create, update, and delete an environment with protection rules",
  (stack) =>
    Effect.gen(function* () {
      const name = "alchemy-test-production";

      // Clean up any leftovers from a previous run before deploying.
      yield* stack.destroy();

      // Create — environment with a wait timer and custom branch patterns.
      // `Repository` defaults to `retain`, so the host repo is created once
      // and reused across runs (reconcile is idempotent).
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* GitHub.Repository("Repo", {
            owner,
            name: repo,
            description: "alchemy-effect environment test",
            visibility: "public",
            autoInit: true,
          });

          return yield* GitHub.Environment("Env", {
            owner,
            // Derive the repo name from a repository output so the engine
            // orders the environment after the repository exists.
            repository: repoName(repository),
            name,
            waitTimer: 5,
            preventSelfReview: true,
            deploymentBranchPolicy: {
              customBranchPolicies: ["main", "release/*"],
            },
          }).pipe(destroy());
        }),
      );

      expect(created.environmentId).toBeGreaterThan(0);
      expect(created.name).toEqual(name);
      expect(created.htmlUrl).toContain(repo);

      const fetched = yield* getEnvironment(name);
      expect(fetched?.id).toEqual(created.environmentId);
      expect(fetched?.deployment_branch_policy?.custom_branch_policies).toBe(
        true,
      );
      const waitRule = fetched?.protection_rules?.find(
        (rule) => rule.type === "wait_timer",
      );
      expect(
        waitRule !== undefined && "wait_timer" in waitRule
          ? waitRule.wait_timer
          : undefined,
      ).toEqual(5);

      const patterns = yield* listBranchPolicies(name);
      expect(patterns.sort()).toEqual(["main", "release/*"]);

      // Update — drop the wait timer, converge the pattern list, same
      // logical ID → same environmentId (update in place, not replace).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* GitHub.Repository("Repo", {
            owner,
            name: repo,
            description: "alchemy-effect environment test",
            visibility: "public",
          });

          return yield* GitHub.Environment("Env", {
            owner,
            repository: repoName(repository),
            name,
            deploymentBranchPolicy: {
              customBranchPolicies: ["main"],
            },
          }).pipe(destroy());
        }),
      );

      expect(updated.environmentId).toEqual(created.environmentId);
      const afterUpdate = yield* getEnvironment(name);
      const waitAfterUpdate = afterUpdate?.protection_rules?.find(
        (rule) => rule.type === "wait_timer",
      );
      expect(waitAfterUpdate).toBeUndefined();
      expect(yield* listBranchPolicies(name)).toEqual(["main"]);

      // Switch the policy mode to protected branches only.
      const switched = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* GitHub.Repository("Repo", {
            owner,
            name: repo,
            description: "alchemy-effect environment test",
            visibility: "public",
          });

          return yield* GitHub.Environment("Env", {
            owner,
            repository: repoName(repository),
            name,
            deploymentBranchPolicy: { protectedBranches: true },
          }).pipe(destroy());
        }),
      );

      expect(switched.environmentId).toEqual(created.environmentId);
      const afterSwitch = yield* getEnvironment(name);
      expect(afterSwitch?.deployment_branch_policy?.protected_branches).toBe(
        true,
      );

      // Delete — the environment goes away; the retained repo stays.
      yield* stack.destroy();
      const afterDestroy = yield* getEnvironment(name);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!owner)(
  "environment-scoped variable lifecycle",
  (stack) =>
    Effect.gen(function* () {
      const name = "alchemy-test-variables";

      yield* stack.destroy();

      const deployVariable = (value: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const repository = yield* GitHub.Repository("Repo", {
              owner,
              name: repo,
              description: "alchemy-effect environment test",
              visibility: "public",
              autoInit: true,
            });

            const environment = yield* GitHub.Environment("Env", {
              owner,
              repository: repoName(repository),
              name,
            }).pipe(destroy());

            // Pass the Environment resource itself — the `environment` prop
            // accepts `string | Environment` and resolves the name.
            return yield* GitHub.Variable("Variable", {
              owner,
              repository: repoName(repository),
              environment,
              name: "ALCHEMY_ENV_TEST",
              value,
            }).pipe(destroy());
          }),
        );

      const readVariable = Effect.gen(function* () {
        const octokit = yield* Octokit;
        return yield* Effect.tryPromise({
          try: async () => {
            try {
              const { data } =
                await octokit.rest.actions.getEnvironmentVariable({
                  owner,
                  repo,
                  environment_name: name,
                  name: "ALCHEMY_ENV_TEST",
                });
              return data;
            } catch (error: any) {
              if (error.status === 404) return undefined;
              throw error;
            }
          },
          catch: (e) => e as Error,
        });
      });

      // Create — the variable lands in the environment, not the repo.
      yield* deployVariable("one");
      const fetched = yield* readVariable;
      expect(fetched?.value).toEqual("one");

      // Update — reconcile PATCHes the drifted value in place.
      yield* deployVariable("two");
      const afterUpdate = yield* readVariable;
      expect(afterUpdate?.value).toEqual("two");

      // Delete — destroying the stack removes the variable (and environment).
      yield* stack.destroy();
      const afterDestroy = yield* readVariable;
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
