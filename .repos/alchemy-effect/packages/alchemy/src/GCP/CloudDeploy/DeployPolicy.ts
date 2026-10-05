import * as clouddeploy from "@distilled.cloud/gcp/clouddeploy_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameBool,
  sameText,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type DeliveryPipelineAttribute = {
  /**
   * Delivery pipeline id, the last segment of a pipeline name, or `*`
   * for all pipelines in the location.
   */
  id?: string;
  /** Pipeline labels that must match. */
  labels?: Record<string, string>;
};

export type DeployPolicyTargetAttribute = {
  /**
   * Target id, the last segment of a Target name, or `*` for all
   * targets in the location.
   */
  id?: string;
  /** Target labels that must match. */
  labels?: Record<string, string>;
};

export type DeployPolicyResourceSelector = {
  /** Delivery pipeline attributes that must match. */
  deliveryPipeline?: DeliveryPipelineAttribute;
  /** Target attributes that must match. */
  target?: DeployPolicyTargetAttribute;
};

export type TimeOfDay = {
  /** Hours of day in 24-hour format (`0`–`23`, or `24` for end of day). */
  hours?: number;
  /** Minutes of hour (`0`–`59`). */
  minutes?: number;
  /** Seconds of minute (`0`–`59`). */
  seconds?: number;
  /** Fractional seconds, in nanoseconds. */
  nanos?: number;
};

export type CalendarDate = {
  /** Year (`1`–`9999`), or `0` to omit. */
  year?: number;
  /** Month (`1`–`12`), or `0` to omit. */
  month?: number;
  /** Day (`1`–`31`), or `0` to omit. */
  day?: number;
};

export type OneTimeWindow = {
  /** Inclusive start date. */
  startDate?: CalendarDate;
  /** Inclusive end date. */
  endDate?: CalendarDate;
  /** Inclusive start time. Use `00:00` for the beginning of the day. */
  startTime?: TimeOfDay;
  /** Exclusive end time. Use `24:00` for the end of the day. */
  endTime?: TimeOfDay;
};

export type WeeklyWindow = {
  /**
   * Days of week. Empty means every day.
   */
  daysOfWeek?: Array<
    clouddeploy.WeeklyWindowDaysOfWeekItemEnum | (string & {})
  >;
  /** Inclusive start time. Must be set with `endTime`. */
  startTime?: TimeOfDay;
  /** Exclusive end time. Must be set with `startTime`. */
  endTime?: TimeOfDay;
};

export type TimeWindows = {
  /** IANA time zone (for example `America/Los_Angeles`). */
  timeZone?: string;
  /** Recurring weekly restriction windows. */
  weeklyWindows?: WeeklyWindow[];
  /** One-time restriction windows. */
  oneTimeWindows?: OneTimeWindow[];
};

export type RolloutRestriction = {
  /** Unique restriction id within the policy. */
  id?: string;
  /**
   * Restricted invokers (`USER`, `DEPLOY_AUTOMATION`). Empty means all
   * invokers.
   */
  invokers?: Array<
    clouddeploy.RolloutRestrictionInvokersItemEnum | (string & {})
  >;
  /**
   * Restricted rollout actions (`ADVANCE`, `APPROVE`, `CANCEL`,
   * `CREATE`, `IGNORE_JOB`, `RETRY_JOB`, `ROLLBACK`,
   * `TERMINATE_JOBRUN`). Empty means all actions.
   */
  actions?: Array<
    clouddeploy.RolloutRestrictionActionsItemEnum | (string & {})
  >;
  /** Time windows during which actions are restricted. */
  timeWindows?: TimeWindows;
};

export type PolicyRule = {
  /** Rollout restriction for this rule. */
  rolloutRestriction?: RolloutRestriction;
};

export type DeployPolicyProps = {
  /**
   * Deploy policy id (the `{deployPolicy}` segment of
   * `projects/{project}/locations/{location}/deployPolicies/{deployPolicy}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the policy.
   */
  deployPolicyId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Resources the policy applies to. At least one selector is required.
   */
  selectors: DeployPolicyResourceSelector[];
  /**
   * Policy rules. At least one rule is required.
   */
  rules: PolicyRule[];
  /**
   * Human-readable description. Max length 255 characters.
   */
  description?: string;
  /**
   * When true, the policy does not block actions even if they violate it.
   * @default false
   */
  suspended?: boolean;
  /**
   * User annotations (not used by Cloud Deploy).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type DeployPolicy = Resource<
  "GCP.CloudDeploy.DeployPolicy",
  DeployPolicyProps,
  {
    /** Full resource name. */
    name: string;
    /** Deploy policy id (last path segment). */
    deployPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Resource selectors. */
    selectors: DeployPolicyResourceSelector[];
    /** Policy rules. */
    rules: PolicyRule[];
    /** Human-readable description. */
    description: string | undefined;
    /** Whether the policy is suspended. */
    suspended: boolean;
    /** User annotations. */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-computed etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Deploy policy that restricts rollout actions on selected
 * delivery pipelines and targets (for example a weekend freeze).
 *
 * Changing `deployPolicyId` or `location` replaces the policy.
 * Selectors, rules, description, labels, annotations, and `suspended`
 * update in place.
 *
 * ### Creating a Deploy Policy
 * **Example:** Weekend freeze
 * ```typescript
 * const policy = yield* GCP.CloudDeploy.DeployPolicy("Freeze", {
 *   selectors: [{ target: { id: "*" } }],
 *   rules: [{
 *     rolloutRestriction: {
 *       id: "weekends",
 *       timeWindows: {
 *         timeZone: "America/Los_Angeles",
 *         weeklyWindows: [{ daysOfWeek: ["SATURDAY", "SUNDAY"] }],
 *       },
 *     },
 *   }],
 * });
 * ```
 *
 * **Example:** Business-hours only
 * ```typescript
 * const policy = yield* GCP.CloudDeploy.DeployPolicy("Freeze", {
 *   selectors: [{ deliveryPipeline: { id: "prod" } }],
 *   rules: [{
 *     rolloutRestriction: {
 *       id: "after-hours",
 *       actions: ["CREATE", "APPROVE"],
 *       timeWindows: {
 *         timeZone: "America/New_York",
 *         weeklyWindows: [{
 *           daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
 *           startTime: { hours: 17 },
 *           endTime: { hours: 24 },
 *         }],
 *       },
 *     },
 *   }],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Deploy Policy
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description and labels
 * ```typescript
 * const policy = yield* GCP.CloudDeploy.DeployPolicy("Freeze", {
 *   selectors: [{ target: { id: "*" } }],
 *   rules: [{
 *     rolloutRestriction: {
 *       id: "weekends",
 *       timeWindows: {
 *         timeZone: "America/Los_Angeles",
 *         weeklyWindows: [{ daysOfWeek: ["SATURDAY", "SUNDAY"] }],
 *       },
 *     },
 *   }],
 *   description: "weekend freeze v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category CloudDeploy
 */
export const DeployPolicy = Resource<DeployPolicy>(
  "GCP.CloudDeploy.DeployPolicy",
);

const resourceName = (
  project: string,
  location: string,
  deployPolicyId: string,
) =>
  `projects/${project}/locations/${location}/deployPolicies/${deployPolicyId}`;

const toSelectors = (
  value: clouddeploy.DeployPolicyResourceSelectorList | undefined,
): DeployPolicyResourceSelector[] =>
  (value ?? []).map((selector) => ({
    deliveryPipeline:
      selector.deliveryPipeline === undefined
        ? undefined
        : {
            id: selector.deliveryPipeline.id,
            labels: stringMap(selector.deliveryPipeline.labels),
          },
    target:
      selector.target === undefined
        ? undefined
        : {
            id: selector.target.id,
            labels: stringMap(selector.target.labels),
          },
  }));

const toRules = (value: clouddeploy.PolicyRuleList | undefined): PolicyRule[] =>
  (value ?? []).map((rule) => ({
    rolloutRestriction:
      rule.rolloutRestriction === undefined
        ? undefined
        : {
            id: rule.rolloutRestriction.id,
            invokers: rule.rolloutRestriction.invokers,
            actions: rule.rolloutRestriction.actions,
            timeWindows: rule.rolloutRestriction.timeWindows,
          },
  }));

const toAttrs = (item: clouddeploy.DeployPolicy, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "deployPolicies");
  return {
    name,
    deployPolicyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    selectors: toSelectors(item.selectors),
    rules: toRules(item.rules),
    description: item.description,
    suspended: item.suspended === true,
    annotations: stringMap(item.annotations),
    labels: userLabels(item.labels),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  clouddeploy
    .getProjectsLocationsDeployPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      clouddeploy.listProjectsLocationsDeployPolicies.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.deployPolicies,
      (item) => item.labels,
    ),
  );

export const DeployPolicyProvider = () =>
  Provider.succeed(DeployPolicy, {
    stables: [
      "name",
      "deployPolicyId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.deployPolicyId ?? output?.deployPolicyId,
        nextId:
          news.deployPolicyId ?? olds?.deployPolicyId ?? output?.deployPolicyId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const deployPolicyId = yield* toPhysicalId(
        id,
        olds?.deployPolicyId,
        output?.deployPolicyId,
        "deploypolicy",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, deployPolicyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const deployPolicyId = yield* toPhysicalId(
        id,
        news.deployPolicyId,
        output?.deployPolicyId,
        "deploypolicy",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, deployPolicyId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const desiredSuspended = news.suspended === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* clouddeploy
          .createProjectsLocationsDeployPolicies({
            parent: parentOf(env.project, location),
            deployPolicyId,
            body: {
              selectors: news.selectors,
              rules: news.rules,
              description: news.description,
              suspended: desiredSuspended,
              annotations: desiredAnnotations,
              labels: desiredLabels,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        fingerprint(stringMap(current.annotations)) !==
          fingerprint(desiredAnnotations) && "annotations",
        !sameText(current.description, news.description) && "description",
        !sameBool(current.suspended, desiredSuspended) && "suspended",
        fingerprint(toSelectors(current.selectors)) !==
          fingerprint(news.selectors) && "selectors",
        fingerprint(toRules(current.rules)) !== fingerprint(news.rules) &&
          "rules",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* clouddeploy.patchProjectsLocationsDeployPolicies({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              selectors: news.selectors,
              rules: news.rules,
              description: news.description,
              suspended: desiredSuspended,
              annotations: desiredAnnotations,
              labels: desiredLabels,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* clouddeploy
        .deleteProjectsLocationsDeployPolicies({
          name: output.name,
          allowMissing: true,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
