import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  ResourceNotResolved,
  encodeOwnership,
  expandRepository,
  fieldMask,
  hasOwnershipMarker,
  listAlchemyRepositories,
  listChildResources,
  listRules,
  locationFromRepository,
  missingGet,
  normalizeLocation,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
} from "./internal.ts";

const DEFAULT_OPERATION = "DOWNLOAD";
const OWNERSHIP_TRUE = "true";

export type RuleCondition = {
  /** CEL expression that must match for the rule to apply. */
  expression?: string;
  /** Short title for the expression. */
  title?: string;
  /** Longer description of the expression. */
  description?: string;
  /** Source location used in error reporting. */
  location?: string;
};

export type RepositoriesRuleProps = {
  /**
   * Parent repository. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}`
   * or the repository id (combined with `location`). Immutable —
   * changing it replaces the rule.
   */
  repository: string;
  /**
   * Region used when `repository` is a bare id.
   * @default the repository's location, else the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Rule id (the `{rule}` segment of `.../repositories/{repository}/rules/{rule}`).
   * If omitted, a unique name is generated. Max 256 characters:
   * alphanumeric plus `-._~:@+^`. Immutable — changing it replaces the
   * rule.
   */
  ruleId?: string;
  /**
   * Action applied to matching downloads.
   */
  action:
    | artifactregistry.GoogleDevtoolsArtifactregistryV1RuleActionEnum
    | (string & {});
  /**
   * Operation the rule applies to.
   * @default "DOWNLOAD"
   */
  operation?:
    | artifactregistry.GoogleDevtoolsArtifactregistryV1RuleOperationEnum
    | (string & {});
  /**
   * Package id this rule applies to. Empty or omitted applies to every
   * package in the repository. Each repository may have one
   * repository-level rule and one rule per package.
   */
  packageId?: string;
  /**
   * Optional CEL condition. Rules have no labels field, so Alchemy stamps
   * ownership into `condition.title`.
   */
  condition?: RuleCondition;
};

export type RepositoriesRule = Resource<
  "GCP.ArtifactRegistry.RepositoriesRule",
  RepositoriesRuleProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/repositories/{repository}/rules/{rule}`. */
    name: string;
    /** Rule id (last path segment). */
    ruleId: string;
    /** Parent repository resource name. */
    repository: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`). */
    location: string;
    /** Action (`ALLOW` or `DENY`). */
    action: string | undefined;
    /** Operation (`DOWNLOAD`). */
    operation: string | undefined;
    /** Package id, if the rule is package-scoped. */
    packageId: string | undefined;
    /** User CEL condition with Alchemy ownership stripped from `title`. */
    condition: RuleCondition | undefined;
  },
  never,
  Providers
>;

/**
 * An Artifact Registry download rule on a repository.
 *
 * Download rules are a Preview API. Each repository may have one
 * repository-level rule and one rule per package. Changing `repository`,
 * `location`, or `ruleId` replaces the rule. `action`, `operation`,
 * `packageId`, and `condition` update in place.
 *
 * Rules have no labels field. Alchemy stamps ownership into
 * `condition.title` so `list` / `pnpm nuke:gcp` can find them.
 *
 * ### Creating a RepositoriesRule
 * **Example:** Deny all downloads
 * ```typescript
 * const rule = yield* GCP.ArtifactRegistry.RepositoriesRule("Deny", {
 *   repository: images.name,
 *   action: "DENY",
 * });
 * ```
 *
 * **Example:** Allow a package except old versions
 * ```typescript
 * const rule = yield* GCP.ArtifactRegistry.RepositoriesRule("AllowApp", {
 *   repository: images.name,
 *   action: "ALLOW",
 *   packageId: "app",
 *   condition: { expression: "pkg.version.id >= '1.0.0'" },
 * });
 * ```
 *
 * @resource
 * @category ArtifactRegistry
 */
export const RepositoriesRule = Resource<RepositoriesRule>(
  "GCP.ArtifactRegistry.RepositoriesRule",
);

const normalizeOperation = (operation: string | undefined) => {
  const value = (operation ?? DEFAULT_OPERATION).toUpperCase();
  return value === "OPERATION_UNSPECIFIED" ? DEFAULT_OPERATION : value;
};

const normalizeAction = (action: string) => action.toUpperCase();

const resourceNameOf = (repository: string, ruleId: string) =>
  `${repository}/rules/${ruleId}`;

const desiredCondition = (
  news: RepositoriesRuleProps,
  ownership: Record<string, string>,
): artifactregistry.Expr => {
  const expression =
    news.condition?.expression && news.condition.expression.length > 0
      ? news.condition.expression
      : OWNERSHIP_TRUE;
  return {
    expression,
    title: encodeOwnership(ownership, news.condition?.title),
    description: news.condition?.description,
    location: news.condition?.location,
  };
};

const toUserCondition = (
  condition: artifactregistry.Expr | undefined,
): RuleCondition | undefined => {
  if (condition === undefined) return undefined;
  const ownership = parseOwnership(condition.title);
  const title = ownership.text;
  const expression = condition.expression;
  const description = condition.description;
  const location = condition.location;
  const ownershipOnly =
    expression === OWNERSHIP_TRUE &&
    title === undefined &&
    (description === undefined || description.length === 0) &&
    (location === undefined || location.length === 0);
  if (ownershipOnly) return undefined;
  return {
    expression,
    title,
    description,
    location,
  };
};

const toAttrs = (
  rule: artifactregistry.GoogleDevtoolsArtifactregistryV1Rule,
  project: string,
  region: string,
) => {
  const name = rule.name ?? "";
  const parsed = parseName(name, "rules", region);
  return {
    name,
    ruleId: parsed.id,
    repository: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    action: rule.action,
    operation: normalizeOperation(rule.operation),
    packageId:
      rule.packageId && rule.packageId.length > 0 ? rule.packageId : undefined,
    condition: toUserCondition(rule.condition),
  };
};

const getByName = missingGet(
  artifactregistry.getProjectsLocationsRepositoriesRules,
);

export const RepositoriesRuleProvider = () =>
  Provider.succeed(RepositoriesRule, {
    stables: ["name", "ruleId", "repository", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.ruleId ?? output?.ruleId;
      const nextId = news.ruleId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ??
          locationFromRepository(news.repository, previousLocation),
        env.region,
      );
      return replaceOnIdentity({
        previousId,
        nextId,
        previousLocation,
        nextLocation,
        previousParent: olds?.repository ?? output?.repository,
        nextParent: news.repository,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          locationFromRepository(
            olds?.repository ?? output?.repository,
            env.region,
          ),
        env.region,
      );
      const repository = expandRepository(
        olds?.repository ?? output?.repository ?? "",
        env.project,
        location,
      );
      const ruleId = yield* toPhysicalId(
        id,
        olds?.ruleId,
        output?.ruleId,
        "rule",
      );
      const name = output?.name ?? resourceNameOf(repository, ruleId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const { labels } = parseOwnership(existing.condition?.title);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const repos = yield* listAlchemyRepositories(env.project);
        const rules = yield* listChildResources(repos, listRules);
        return rules
          .filter((rule) => hasOwnershipMarker(rule.condition?.title))
          .map((rule) => toAttrs(rule, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationFromRepository(news.repository, env.region),
        env.region,
      );
      const repository = expandRepository(
        news.repository,
        env.project,
        location,
      );
      const ruleId = yield* toPhysicalId(
        id,
        news.ruleId,
        output?.ruleId,
        "rule",
      );
      const name = resourceNameOf(repository, ruleId);
      const ownership = yield* createInternalLabels(id);
      const action = normalizeAction(news.action);
      const operation = normalizeOperation(news.operation);
      const packageId = news.packageId;
      const condition = desiredCondition(news, ownership);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* artifactregistry
          .createProjectsLocationsRepositoriesRules({
            parent: repository,
            ruleId,
            body: {
              action,
              operation,
              packageId,
              condition,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observed = current.name ?? name;
      const actionChanged = normalizeAction(current.action ?? "") !== action;
      const operationChanged =
        normalizeOperation(current.operation) !== operation;
      const packageChanged = !sameText(current.packageId, packageId);
      const conditionChanged = !sameJson(current.condition, condition);
      const updateMask = fieldMask([
        actionChanged && "action",
        operationChanged && "operation",
        packageChanged && "packageId",
        conditionChanged && "condition",
      ]);

      if (updateMask.length > 0) {
        current =
          yield* artifactregistry.patchProjectsLocationsRepositoriesRules({
            name: observed,
            updateMask,
            body: {
              name: observed,
              action,
              operation,
              packageId,
              condition,
            },
          });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* artifactregistry
        .deleteProjectsLocationsRepositoriesRules({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
