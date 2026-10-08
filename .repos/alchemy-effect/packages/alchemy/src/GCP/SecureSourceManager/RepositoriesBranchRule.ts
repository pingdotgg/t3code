import * as ssm from "@distilled.cloud/gcp/securesourcemanager_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  catchMissing,
  collectPages,
  desiredAnnotations,
  expandName,
  fieldMask,
  fingerprint,
  forEachRepository,
  hasAlchemyLabelMap,
  normalizeLocation,
  PAGE_SIZE,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  retryConflict,
  rfc1035,
  sameText,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type BranchRuleCheck = {
  /** Required status-check context (GitHub-style check name). */
  context?: string;
};

export type RepositoriesBranchRuleProps = {
  /**
   * Parent repository. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}`
   * or the repository id (combined with `location`). Immutable —
   * changing it replaces the rule.
   */
  repository: string;
  /**
   * Region used when `repository` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Branch rule id (the `{branchRule}` segment). If omitted, a unique
   * RFC1035 name is generated. Immutable — changing it replaces the rule.
   */
  branchRuleId?: string;
  /**
   * Regex of branches this rule matches. `.*` matches every branch.
   * @default ".*"
   */
  includePattern?: string;
  /**
   * When true, the rule is disabled.
   * @default false
   */
  disabled?: boolean;
  /**
   * When true, matching branches require a pull request.
   * @default false
   */
  requirePullRequest?: boolean;
  /**
   * Minimum number of approvals required before merge.
   */
  minimumApprovalsCount?: number;
  /**
   * Minimum number of reviews required before merge.
   */
  minimumReviewsCount?: number;
  /**
   * When true, reviews may be stale relative to the latest commit.
   * @default false
   */
  allowStaleReviews?: boolean;
  /**
   * When true, require linear history before merge.
   * @default false
   */
  requireLinearHistory?: boolean;
  /**
   * When true, require all comments resolved before merge.
   * @default false
   */
  requireCommentsResolved?: boolean;
  /**
   * When true, require a code-owner approval before merge.
   * @default false
   */
  requireCodeOwnerApproval?: boolean;
  /**
   * Required status checks before merging.
   */
  requiredStatusChecks?: BranchRuleCheck[];
  /**
   * User annotations. Alchemy ownership keys (`alchemy-stack`,
   * `alchemy-stage`, `alchemy-id`) are merged in automatically. Branch
   * rules have no labels field.
   */
  annotations?: Record<string, string>;
};

export type RepositoriesBranchRule = Resource<
  "GCP.SecureSourceManager.RepositoriesBranchRule",
  RepositoriesBranchRuleProps,
  {
    /** Full resource name. */
    name: string;
    /** Branch rule id (last path segment). */
    branchRuleId: string;
    /** Parent repository resource name. */
    repository: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Branch-name regex this rule matches. */
    includePattern: string | undefined;
    /** Whether the rule is disabled. */
    disabled: boolean;
    /** Whether a pull request is required. */
    requirePullRequest: boolean;
    /** Minimum approvals required. */
    minimumApprovalsCount: number | undefined;
    /** Minimum reviews required. */
    minimumReviewsCount: number | undefined;
    /** Whether stale reviews are allowed. */
    allowStaleReviews: boolean;
    /** Whether linear history is required. */
    requireLinearHistory: boolean;
    /** Whether comments must be resolved. */
    requireCommentsResolved: boolean;
    /** Whether code-owner approval is required. */
    requireCodeOwnerApproval: boolean;
    /** Required status checks. */
    requiredStatusChecks: BranchRuleCheck[];
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Secure Source Manager branch protection rule.
 *
 * Changing `branchRuleId`, `repository`, or `location` replaces the rule.
 * Pattern, flags, checks, and annotations update in place. Ownership for
 * `list` / nuke is stamped into `annotations`.
 *
 * ### Creating a Branch Rule
 * **Example:** Protect the default branch
 * ```typescript
 * const rule = yield* GCP.SecureSourceManager.RepositoriesBranchRule("Main", {
 *   repository: repo.name,
 *   includePattern: "main",
 *   requirePullRequest: true,
 *   minimumApprovalsCount: 1,
 * });
 * ```
 *
 * **Example:** Named rule with annotations
 * ```typescript
 * const rule = yield* GCP.SecureSourceManager.RepositoriesBranchRule("Main", {
 *   repository: repo.name,
 *   branchRuleId: "protect-main",
 *   includePattern: "main",
 *   requireCommentsResolved: true,
 *   annotations: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Branch Rule
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Raise the approval floor
 * ```typescript
 * const rule = yield* GCP.SecureSourceManager.RepositoriesBranchRule("Main", {
 *   repository: repo.name,
 *   includePattern: "main",
 *   requirePullRequest: true,
 *   minimumApprovalsCount: 2,
 *   annotations: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category SecureSourceManager
 */
export const RepositoriesBranchRule = Resource<RepositoriesBranchRule>(
  "GCP.SecureSourceManager.RepositoriesBranchRule",
);

const resourceName = (repository: string, branchRuleId: string) =>
  `${repository}/branchRules/${branchRuleId}`;

const toChecks = (
  checks: readonly ssm.Check[] | readonly BranchRuleCheck[] | undefined,
): BranchRuleCheck[] =>
  (checks ?? [])
    .map((check) => ({ context: check.context }))
    .sort((left, right) =>
      (left.context ?? "").localeCompare(right.context ?? ""),
    );

const toAttrs = (item: ssm.BranchRule, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "branchRules", region);
  return {
    name,
    branchRuleId: parsed.id,
    repository: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    includePattern: item.includePattern,
    disabled: item.disabled === true,
    requirePullRequest: item.requirePullRequest === true,
    minimumApprovalsCount: item.minimumApprovalsCount,
    minimumReviewsCount: item.minimumReviewsCount,
    allowStaleReviews: item.allowStaleReviews === true,
    requireLinearHistory: item.requireLinearHistory === true,
    requireCommentsResolved: item.requireCommentsResolved === true,
    requireCodeOwnerApproval: item.requireCodeOwnerApproval === true,
    requiredStatusChecks: toChecks(item.requiredStatusChecks),
    annotations: userLabels(item.annotations),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(ssm.getProjectsLocationsRepositoriesBranchRules({ name }));

const listOnRepository = (repository: string) =>
  collectPages(
    ssm.listProjectsLocationsRepositoriesBranchRules.pages({
      parent: repository,
      pageSize: PAGE_SIZE,
    }),
    (page) => page.branchRules,
  );

const listOwned = (project: string, region: string) =>
  forEachRepository(project, region, (repository) =>
    listOnRepository(repository).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.annotations)),
      ),
    ),
  );

export const RepositoriesBranchRuleProvider = () =>
  Provider.succeed(RepositoriesBranchRule, {
    stables: [
      "name",
      "branchRuleId",
      "repository",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      return replaceOnIdentity({
        previousId: olds?.branchRuleId ?? output?.branchRuleId,
        nextId: news.branchRuleId
          ? rfc1035(news.branchRuleId, "branchrule")
          : (olds?.branchRuleId ?? output?.branchRuleId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        previousParent: olds?.repository ?? output?.repository,
        nextParent: expandName(
          news.repository,
          env.project,
          location,
          "repositories",
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const branchRuleId = yield* toPhysicalId(
        id,
        olds?.branchRuleId,
        output?.branchRuleId,
        "branchrule",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const repository = expandName(
        olds?.repository ?? output?.repository ?? "",
        env.project,
        location,
        "repositories",
      );
      const name =
        output?.name ??
        (repository.length > 0 ? resourceName(repository, branchRuleId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.annotations)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item: ssm.BranchRule) =>
          toAttrs(item, env.project, env.region),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const branchRuleId = yield* toPhysicalId(
        id,
        news.branchRuleId,
        output?.branchRuleId,
        "branchrule",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const repository = expandName(
        news.repository,
        env.project,
        location,
        "repositories",
      );
      const name = resourceName(repository, branchRuleId);
      const ownership = yield* createInternalLabels(id);
      const annotations = desiredAnnotations(news.annotations, ownership);
      const includePattern = news.includePattern ?? ".*";
      const requiredStatusChecks = toChecks(news.requiredStatusChecks);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* ssm
          .createProjectsLocationsRepositoriesBranchRules({
            parent: repository,
            branchRuleId,
            body: {
              includePattern,
              disabled: news.disabled === true ? true : undefined,
              requirePullRequest:
                news.requirePullRequest === true ? true : undefined,
              minimumApprovalsCount: news.minimumApprovalsCount,
              minimumReviewsCount: news.minimumReviewsCount,
              allowStaleReviews:
                news.allowStaleReviews === true ? true : undefined,
              requireLinearHistory:
                news.requireLinearHistory === true ? true : undefined,
              requireCommentsResolved:
                news.requireCommentsResolved === true ? true : undefined,
              requireCodeOwnerApproval:
                news.requireCodeOwnerApproval === true ? true : undefined,
              requiredStatusChecks:
                requiredStatusChecks.length > 0
                  ? requiredStatusChecks
                  : undefined,
              annotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observed = tagRecord(current.annotations);
      const { upsert, removed } = diffLabels(observed, annotations);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "annotations",
        !sameText(current.includePattern, includePattern) && "includePattern",
        (current.disabled === true) !== (news.disabled === true) && "disabled",
        (current.requirePullRequest === true) !==
          (news.requirePullRequest === true) && "requirePullRequest",
        current.minimumApprovalsCount !== news.minimumApprovalsCount &&
          "minimumApprovalsCount",
        current.minimumReviewsCount !== news.minimumReviewsCount &&
          "minimumReviewsCount",
        (current.allowStaleReviews === true) !==
          (news.allowStaleReviews === true) && "allowStaleReviews",
        (current.requireLinearHistory === true) !==
          (news.requireLinearHistory === true) && "requireLinearHistory",
        (current.requireCommentsResolved === true) !==
          (news.requireCommentsResolved === true) && "requireCommentsResolved",
        (current.requireCodeOwnerApproval === true) !==
          (news.requireCodeOwnerApproval === true) &&
          "requireCodeOwnerApproval",
        fingerprint(toChecks(current.requiredStatusChecks)) !==
          fingerprint(requiredStatusChecks) && "requiredStatusChecks",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* ssm.patchProjectsLocationsRepositoriesBranchRules({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              includePattern,
              disabled: news.disabled === true,
              requirePullRequest: news.requirePullRequest === true,
              minimumApprovalsCount: news.minimumApprovalsCount,
              minimumReviewsCount: news.minimumReviewsCount,
              allowStaleReviews: news.allowStaleReviews === true,
              requireLinearHistory: news.requireLinearHistory === true,
              requireCommentsResolved: news.requireCommentsResolved === true,
              requireCodeOwnerApproval: news.requireCodeOwnerApproval === true,
              requiredStatusChecks,
              annotations,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* retryConflict(
        ssm
          .deleteProjectsLocationsRepositoriesBranchRules({
            name: output.name,
            allowMissing: true,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
