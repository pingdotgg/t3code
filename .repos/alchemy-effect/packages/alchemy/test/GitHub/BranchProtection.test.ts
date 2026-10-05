import * as GitHub from "@/GitHub";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (owner !== "alchemy-run-test" && owner !== "alchemy-run-test-2") {
  throw new Error(
    `Refusing GitHub mutations outside the test organizations: ${owner}`,
  );
}

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Public fixtures avoid plan gates and are retained because gh lacks delete_repo.
const repo = "alchemy-effect-pr-1514-branch-protection";
const replacementRepo = "alchemy-effect-pr-1514-branch-protection-replacement";

// Derive the repository name from the `fullName` output — referencing an
// output (rather than the `repo` constant) makes the engine order dependent
// resources after the repository exists.
const repoName = (repository: GitHub.Repository) =>
  Output.map(repository.fullName, (fullName) => fullName.split("/")[1]!);

const getProtection = (branch: string, repository: string = repo) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          const { data } = await octokit.rest.repos.getBranchProtection({
            owner,
            repo: repository,
            branch,
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

const hostRepository = GitHub.Repository("Repo", {
  owner,
  name: repo,
  description: "alchemy-effect branch protection test",
  visibility: "public",
  autoInit: true,
});

test.provider(
  "create, update, replace, and delete a branch protection rule",
  (stack) =>
    Effect.gen(function* () {
      // Clean up any leftovers from a previous run before deploying.
      yield* stack.destroy();

      // Create — protect the default branch with reviews, status checks, and
      // the strict toggles. `Repository` defaults to `retain`, so the host
      // repo is created once and reused across runs (reconcile is
      // idempotent); `autoInit` guarantees the default branch exists.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* hostRepository;

          return yield* GitHub.BranchProtection("Protection", {
            owner,
            repository: repoName(repository),
            branch: repository.defaultBranch,
            requiredStatusChecks: {
              strict: true,
              contexts: ["ci"],
            },
            requiredPullRequestReviews: {
              requiredApprovingReviewCount: 1,
              dismissStaleReviews: true,
            },
            enforceAdmins: true,
            requiredLinearHistory: true,
            requiredConversationResolution: true,
          }).pipe(destroy());
        }),
      );

      expect(created.url).toContain(`/repos/${owner}/${repo}/branches/`);
      expect(created.branch.length).toBeGreaterThan(0);
      expect(created.enforceAdmins).toBe(true);
      expect(created.requiredLinearHistory).toBe(true);
      expect(created.requiredConversationResolution).toBe(true);
      expect(created.requiredSignatures).toBe(false);
      expect(created.allowForcePushes).toBe(false);

      const fetched = yield* getProtection(created.branch);
      expect(fetched?.required_status_checks?.strict).toBe(true);
      expect(fetched?.required_status_checks?.contexts).toEqual(["ci"]);
      expect(
        fetched?.required_pull_request_reviews?.required_approving_review_count,
      ).toEqual(1);
      expect(
        fetched?.required_pull_request_reviews?.dismiss_stale_reviews,
      ).toBe(true);
      expect(fetched?.enforce_admins?.enabled).toBe(true);
      expect(fetched?.required_linear_history?.enabled).toBe(true);
      expect(fetched?.required_conversation_resolution?.enabled).toBe(true);

      const provider = yield* Provider.findProvider(GitHub.BranchProtection);
      const recovered = yield* provider.read!({
        id: "Protection",
        fqn: "Protection",
        instanceId: "pr-1514",
        olds: { owner, repository: repo, branch: created.branch },
        output: undefined,
      });
      expect(recovered?.url).toEqual(created.url);
      expect(recovered?.enforceAdmins).toBe(true);

      // Update — drop reviews and status checks, relax admin enforcement,
      // allow force pushes, and require signed commits (the aspect that lives
      // behind its own endpoint). Same logical ID → same rule URL (update in
      // place, not replace).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* hostRepository;

          return yield* GitHub.BranchProtection("Protection", {
            owner,
            repository: repoName(repository),
            branch: repository.defaultBranch,
            allowForcePushes: true,
            requiredSignatures: true,
            requiredLinearHistory: true,
          }).pipe(destroy());
        }),
      );

      expect(updated.url).toEqual(created.url);
      expect(updated.enforceAdmins).toBe(false);
      expect(updated.allowForcePushes).toBe(true);
      expect(updated.requiredSignatures).toBe(true);
      expect(updated.requiredConversationResolution).toBe(false);

      const afterUpdate = yield* getProtection(created.branch);
      expect(afterUpdate?.required_status_checks).toBeUndefined();
      expect(afterUpdate?.required_pull_request_reviews).toBeUndefined();
      expect(afterUpdate?.enforce_admins?.enabled).toBe(false);
      expect(afterUpdate?.allow_force_pushes?.enabled).toBe(true);
      expect(afterUpdate?.required_signatures?.enabled).toBe(true);
      expect(afterUpdate?.required_linear_history?.enabled).toBe(true);

      // Re-deploying the same props is a no-op that still converges.
      const unchanged = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* hostRepository;

          return yield* GitHub.BranchProtection("Protection", {
            owner,
            repository: repoName(repository),
            branch: repository.defaultBranch,
            allowForcePushes: true,
            requiredSignatures: true,
            requiredLinearHistory: true,
          }).pipe(destroy());
        }),
      );
      expect(unchanged.url).toEqual(created.url);
      expect(unchanged.requiredSignatures).toBe(true);

      const reset = yield* stack.deploy(
        Effect.gen(function* () {
          const repository = yield* hostRepository;
          return yield* GitHub.BranchProtection("Protection", {
            owner,
            repository: repoName(repository),
            branch: repository.defaultBranch,
          }).pipe(destroy());
        }),
      );
      expect(reset.requiredSignatures).toBe(false);
      expect(reset.allowForcePushes).toBe(false);
      expect(reset.requiredLinearHistory).toBe(false);
      const afterReset = yield* getProtection(created.branch);
      expect(afterReset?.required_signatures?.enabled ?? false).toBe(false);
      expect(afterReset?.allow_force_pushes?.enabled).toBe(false);
      expect(afterReset?.required_linear_history?.enabled).toBe(false);

      // Keep the old dependency deployed until its protection is replaced.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          yield* hostRepository;
          const repository = yield* GitHub.Repository("ReplacementRepo", {
            owner,
            name: replacementRepo,
            description: "alchemy-effect PR 1514 replacement fixture",
            visibility: "public",
            autoInit: true,
          });
          return yield* GitHub.BranchProtection("Protection", {
            owner,
            repository: repoName(repository),
            branch: repository.defaultBranch,
            enforceAdmins: true,
          }).pipe(destroy());
        }),
      );
      expect(replaced.url).not.toEqual(created.url);
      expect(replaced.url).toContain(
        `/repos/${owner}/${replacementRepo}/branches/`,
      );
      expect(yield* getProtection(created.branch)).toBeUndefined();
      expect(
        (yield* getProtection(replaced.branch, replacementRepo))?.enforce_admins
          ?.enabled,
      ).toBe(true);

      // Both rules must be gone independently of the retained repositories.
      yield* stack.destroy();
      expect(yield* getProtection(created.branch)).toBeUndefined();
      expect(
        yield* getProtection(replaced.branch, replacementRepo),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: [
      "provider:github",
      "provider:github:branchprotection",
      "provider:github:repository",
      "live",
    ],
    timeout: 120_000,
  },
);
