import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface BranchProtectionProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Name of the branch to protect (e.g. `main`). The branch is the rule's
   * identity — changing it replaces the protection. The branch must exist.
   */
  branch: string;

  /**
   * Require status checks to pass before merging. Omit to disable.
   */
  requiredStatusChecks?: {
    /**
     * Require branches to be up to date with the base branch before merging.
     * @default false
     */
    strict?: boolean;

    /**
     * Status check contexts that must pass. Prefer `checks` for control over
     * which GitHub App must report the check.
     */
    contexts?: string[];

    /**
     * Status checks that must pass, optionally pinned to the GitHub App that
     * must report them.
     */
    checks?: {
      /**
       * Name of the required check.
       */
      context: string;

      /**
       * ID of the GitHub App that must provide this check. Omit to accept the
       * app that most recently reported it; pass `-1` to accept any app.
       */
      appId?: number;
    }[];
  };

  /**
   * Require pull request reviews before merging. Omit to disable.
   */
  requiredPullRequestReviews?: {
    /**
     * Dismiss approving reviews when a new commit is pushed.
     * @default false
     */
    dismissStaleReviews?: boolean;

    /**
     * Block merging until code owners have reviewed.
     * @default false
     */
    requireCodeOwnerReviews?: boolean;

    /**
     * Number of approving reviews required (0–6).
     * @default 0
     */
    requiredApprovingReviewCount?: number;

    /**
     * Require the most recent push to be approved by someone other than the
     * pusher.
     * @default false
     */
    requireLastPushApproval?: boolean;

    /**
     * Who may dismiss pull request reviews. Only available on
     * organization-owned repositories; omit for personal repositories.
     */
    dismissalRestrictions?: {
      /**
       * User logins with dismissal access.
       */
      users?: string[];

      /**
       * Team slugs with dismissal access.
       */
      teams?: string[];

      /**
       * App slugs with dismissal access.
       */
      apps?: string[];
    };

    /**
     * Who may bypass pull request requirements.
     */
    bypassPullRequestAllowances?: {
      /**
       * User logins allowed to bypass.
       */
      users?: string[];

      /**
       * Team slugs allowed to bypass.
       */
      teams?: string[];

      /**
       * App slugs allowed to bypass.
       */
      apps?: string[];
    };
  };

  /**
   * Restrict who can push to the branch. Only available on
   * organization-owned repositories. Omit to disable.
   */
  restrictions?: {
    /**
     * User logins with push access.
     */
    users?: string[];

    /**
     * Team slugs with push access.
     */
    teams?: string[];

    /**
     * App slugs with push access.
     */
    apps?: string[];
  };

  /**
   * Enforce all configured restrictions for repository administrators.
   * @default false
   */
  enforceAdmins?: boolean;

  /**
   * Require signed commits on the branch.
   * @default false
   */
  requiredSignatures?: boolean;

  /**
   * Require a linear commit history (no merge commits). The repository must
   * allow squash or rebase merging.
   * @default false
   */
  requiredLinearHistory?: boolean;

  /**
   * Permit force pushes by anyone with write access.
   * @default false
   */
  allowForcePushes?: boolean;

  /**
   * Permit deletion of the branch by anyone with write access.
   * @default false
   */
  allowDeletions?: boolean;

  /**
   * When `restrictions` is set, also block pushes that create new branches
   * unless the pusher is allowed by the restrictions.
   * @default false
   */
  blockCreations?: boolean;

  /**
   * Require all pull request conversations to be resolved before merging.
   * @default false
   */
  requiredConversationResolution?: boolean;

  /**
   * Make the branch read-only.
   * @default false
   */
  lockBranch?: boolean;

  /**
   * Allow fork syncing (pulling upstream changes) while the branch is locked.
   * @default false
   */
  allowForkSyncing?: boolean;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same branch on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface BranchProtection extends Resource<
  "GitHub.BranchProtection",
  BranchProtectionProps,
  {
    /**
     * API URL of the branch protection rule.
     */
    url: string;

    /**
     * The protected branch name.
     */
    branch: string;

    /**
     * Whether restrictions are enforced for administrators.
     */
    enforceAdmins: boolean;

    /**
     * Whether signed commits are required.
     */
    requiredSignatures: boolean;

    /**
     * Whether a linear history is required.
     */
    requiredLinearHistory: boolean;

    /**
     * Whether force pushes are allowed.
     */
    allowForcePushes: boolean;

    /**
     * Whether branch deletion is allowed.
     */
    allowDeletions: boolean;

    /**
     * Whether conversation resolution is required before merging.
     */
    requiredConversationResolution: boolean;

    /**
     * Whether the branch is locked (read-only).
     */
    lockBranch: boolean;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub branch protection rule.
 *
 * `BranchProtection` manages the classic branch protection settings on a
 * single branch: required status checks, required pull request reviews,
 * push restrictions, admin enforcement, signed commits, linear history, and
 * the force-push / deletion / lock toggles. Pair it with `GitHub.Repository`
 * to protect the default branch of a repository provisioned in the same
 * stack.
 *
 * Branch protection is available on public repositories on every plan;
 * private repositories require GitHub Pro, Team, or Enterprise. Push
 * restrictions and dismissal restrictions are only available on
 * organization-owned repositories.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied
 * by `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token
 * needs `repo` scope and admin access to the repository.
 *
 * ### Protecting a Branch
 * **Example:** Require Pull Request Reviews
 * ```typescript
 * yield* GitHub.BranchProtection("main", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   branch: "main",
 *   requiredPullRequestReviews: {
 *     requiredApprovingReviewCount: 1,
 *     dismissStaleReviews: true,
 *   },
 * });
 * ```
 *
 * **Example:** Require Status Checks and a Linear History
 * ```typescript
 * yield* GitHub.BranchProtection("main", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   branch: "main",
 *   requiredStatusChecks: {
 *     strict: true,
 *     checks: [{ context: "ci" }],
 *   },
 *   requiredLinearHistory: true,
 *   requiredConversationResolution: true,
 *   enforceAdmins: true,
 * });
 * ```
 *
 * ### Protecting a Repository's Default Branch
 * **Example:** Protect the Default Branch of a New Repository
 * ```typescript
 * import * as Output from "alchemy/Output";
 *
 * const repo = yield* GitHub.Repository("repo", {
 *   owner: "my-org",
 *   name: "my-repo",
 *   autoInit: true,
 * });
 *
 * yield* GitHub.BranchProtection("main", {
 *   owner: "my-org",
 *   repository: Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!),
 *   branch: repo.defaultBranch,
 *   requiredPullRequestReviews: { requiredApprovingReviewCount: 1 },
 *   allowForcePushes: false,
 *   allowDeletions: false,
 * });
 * ```
 *
 * ### Restricting Pushes
 * **Example:** Only a Team May Push
 * ```typescript
 * yield* GitHub.BranchProtection("release", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   branch: "release",
 *   restrictions: { teams: ["release-managers"] },
 *   blockCreations: true,
 *   requiredSignatures: true,
 * });
 * ```
 *
 * @resource
 * @product Repository
 */
export const BranchProtection = Resource<BranchProtection>(
  "GitHub.BranchProtection",
);

/**
 * The `GET .../protection` payload. Both the GET and PUT responses share this
 * shape for the fields we surface; every nested block is optional because
 * GitHub omits disabled aspects entirely.
 */
interface ProtectionPayload {
  url?: string;
  enforce_admins?: { enabled?: boolean };
  required_signatures?: { enabled?: boolean };
  required_linear_history?: { enabled?: boolean };
  allow_force_pushes?: { enabled?: boolean };
  allow_deletions?: { enabled?: boolean };
  required_conversation_resolution?: { enabled?: boolean };
  lock_branch?: { enabled?: boolean };
}

const attrsOf = (
  branch: string,
  protection: ProtectionPayload,
): BranchProtection["Attributes"] => ({
  url: protection.url ?? "",
  branch,
  enforceAdmins: protection.enforce_admins?.enabled ?? false,
  requiredSignatures: protection.required_signatures?.enabled ?? false,
  requiredLinearHistory: protection.required_linear_history?.enabled ?? false,
  allowForcePushes: protection.allow_force_pushes?.enabled ?? false,
  allowDeletions: protection.allow_deletions?.enabled ?? false,
  requiredConversationResolution:
    protection.required_conversation_resolution?.enabled ?? false,
  lockBranch: protection.lock_branch?.enabled ?? false,
});

export const BranchProtectionProvider = () =>
  Provider.succeed(BranchProtection, {
    stables: ["url", "branch"],

    // {owner, repository, branch, host} is the rule's path identity — GitHub
    // has no rename, so changing any of them replaces the resource.
    diff: Effect.fn(function* ({ news, olds }) {
      if (olds === undefined) return;
      // Unresolved props may change the path identity and orphan the old rule.
      if (!isResolved(news)) return { action: "replace" };
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.branch !== olds.branch ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const octokit = yield* octokitFor(news.baseUrl);

      // Ensure & Sync — the PUT is a full upsert of the rule. Send explicit
      // values (or `null`) for every aspect so removed props converge back
      // to their defaults rather than being left as-is.
      const checks = news.requiredStatusChecks;
      const reviews = news.requiredPullRequestReviews;
      const restrictions = news.restrictions;

      yield* Effect.tryPromise({
        try: () =>
          octokit.rest.repos.updateBranchProtection({
            owner: news.owner,
            repo: news.repository,
            branch: news.branch,
            required_status_checks:
              checks === undefined
                ? null
                : {
                    strict: checks.strict ?? false,
                    contexts: checks.contexts ?? [],
                    ...(checks.checks === undefined
                      ? {}
                      : {
                          checks: checks.checks.map((check) => ({
                            context: check.context,
                            ...(check.appId === undefined
                              ? {}
                              : { app_id: check.appId }),
                          })),
                        }),
                  },
            enforce_admins: news.enforceAdmins ?? false,
            required_pull_request_reviews:
              reviews === undefined
                ? null
                : {
                    dismiss_stale_reviews: reviews.dismissStaleReviews ?? false,
                    require_code_owner_reviews:
                      reviews.requireCodeOwnerReviews ?? false,
                    required_approving_review_count:
                      reviews.requiredApprovingReviewCount ?? 0,
                    require_last_push_approval:
                      reviews.requireLastPushApproval ?? false,
                    ...(reviews.dismissalRestrictions === undefined
                      ? {}
                      : {
                          dismissal_restrictions: {
                            users: reviews.dismissalRestrictions.users ?? [],
                            teams: reviews.dismissalRestrictions.teams ?? [],
                            apps: reviews.dismissalRestrictions.apps ?? [],
                          },
                        }),
                    ...(reviews.bypassPullRequestAllowances === undefined
                      ? {}
                      : {
                          bypass_pull_request_allowances: {
                            users:
                              reviews.bypassPullRequestAllowances.users ?? [],
                            teams:
                              reviews.bypassPullRequestAllowances.teams ?? [],
                            apps:
                              reviews.bypassPullRequestAllowances.apps ?? [],
                          },
                        }),
                  },
            restrictions:
              restrictions === undefined
                ? null
                : {
                    users: restrictions.users ?? [],
                    teams: restrictions.teams ?? [],
                    apps: restrictions.apps ?? [],
                  },
            required_linear_history: news.requiredLinearHistory ?? false,
            allow_force_pushes: news.allowForcePushes ?? false,
            allow_deletions: news.allowDeletions ?? false,
            block_creations: news.blockCreations ?? false,
            required_conversation_resolution:
              news.requiredConversationResolution ?? false,
            lock_branch: news.lockBranch ?? false,
            allow_fork_syncing: news.allowForkSyncing ?? false,
          }),
        catch: (e) => e as Error,
      });

      // Sync — required signatures live behind dedicated endpoints that the
      // top-level PUT does not touch. Diff the observed flag against the
      // desired one and only call the API on a real change.
      const observed = yield* Effect.tryPromise({
        try: async () => {
          const { data } = await octokit.rest.repos.getBranchProtection({
            owner: news.owner,
            repo: news.repository,
            branch: news.branch,
          });
          return data as ProtectionPayload;
        },
        catch: (e) => e as Error,
      });

      const desiredSignatures = news.requiredSignatures ?? false;
      const observedSignatures = observed.required_signatures?.enabled ?? false;
      if (desiredSignatures !== observedSignatures) {
        yield* Effect.tryPromise({
          try: async () => {
            if (desiredSignatures) {
              await octokit.rest.repos.createCommitSignatureProtection({
                owner: news.owner,
                repo: news.repository,
                branch: news.branch,
              });
            } else {
              await octokit.rest.repos.deleteCommitSignatureProtection({
                owner: news.owner,
                repo: news.repository,
                branch: news.branch,
              });
            }
          },
          catch: (e) => e as Error,
        });
      }

      return attrsOf(news.branch, {
        ...observed,
        required_signatures: { enabled: desiredSignatures },
      });
    }),

    // Refresh from the live rule. A 404 means either the branch is no longer
    // protected or the branch/repository is gone — both are "missing".
    read: Effect.fn(function* ({ olds }) {
      const octokit = yield* octokitFor(olds.baseUrl);

      return yield* Effect.tryPromise({
        try: async () => {
          try {
            const { data } = await octokit.rest.repos.getBranchProtection({
              owner: olds.owner,
              repo: olds.repository,
              branch: olds.branch,
            });
            return attrsOf(olds.branch, data as ProtectionPayload);
          } catch (error: any) {
            if (error.status === 404) return undefined;
            throw error;
          }
        },
        catch: (e) => e as Error,
      });
    }),

    // Enumerate every protected branch across the repositories the token can
    // see — protection rules are keyed by {owner, repository, branch} with no
    // account-wide list endpoint, so walk the repos like the Environment
    // provider does and fetch the rule for each protected branch.
    list: Effect.fn(function* () {
      const octokit = yield* Octokit;

      const repos = yield* Effect.tryPromise({
        try: () =>
          octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
            per_page: 100,
          }),
        catch: (e) => e as Error,
      });

      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          Effect.tryPromise({
            try: async () => {
              try {
                const branches = await octokit.paginate(
                  octokit.rest.repos.listBranches,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    protected: true,
                    per_page: 100,
                  },
                );
                const rules: BranchProtection["Attributes"][] = [];
                for (const branch of branches) {
                  try {
                    const { data } =
                      await octokit.rest.repos.getBranchProtection({
                        owner: repo.owner.login,
                        repo: repo.name,
                        branch: branch.name,
                      });
                    rules.push(attrsOf(branch.name, data as ProtectionPayload));
                  } catch (error: any) {
                    // Protection may be removed between the list and the
                    // get, or the branch may be governed by a ruleset only.
                    if (error.status !== 404) throw error;
                  }
                }
                return rules;
              } catch (error: any) {
                // Repos without branch protection support (plan limits) or
                // where the token lacks access reject with 403/404 — skip
                // them rather than failing the whole enumeration.
                if (error.status === 403 || error.status === 404) {
                  return [];
                }
                throw error;
              }
            },
            catch: (e) => e as Error,
          }),
        { concurrency: 10 },
      );

      return perRepo.flat();
    }),

    delete: Effect.fn(function* ({ olds }) {
      const octokit = yield* octokitFor(olds.baseUrl);

      yield* Effect.tryPromise({
        try: async () => {
          try {
            await octokit.rest.repos.deleteBranchProtection({
              owner: olds.owner,
              repo: olds.repository,
              branch: olds.branch,
            });
          } catch (error: any) {
            // Already unprotected, or the branch/repository is gone.
            if (error.status !== 404) {
              throw error;
            }
          }
        },
        catch: (e) => e as Error,
      });
    }),
  });
