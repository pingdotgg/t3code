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
  expandParent,
  fieldMask,
  fingerprint,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameBool,
  sameText,
  stringMap,
  stripAutomationRules,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type TargetAttribute = {
  /**
   * Target id, the last segment of a Target name, or `*` for all
   * targets in the location.
   */
  id?: string;
  /** Target labels that must match. */
  labels?: Record<string, string>;
};

export type AutomationResourceSelector = {
  /** Target attributes the automation applies to. */
  targets?: TargetAttribute[];
};

export type AdvanceRolloutRule = {
  /** Unique rule id within the Automation. */
  id?: string;
  /** How long to wait after a rollout finishes. */
  wait?: string;
  /** Source phases that must match before advancing. */
  sourcePhases?: string[];
};

export type PromoteReleaseRule = {
  /** Unique rule id within the Automation. */
  id?: string;
  /**
   * Destination stage id, or `@next` for the next stage in the
   * promotion flow.
   */
  destinationTargetId?: string;
  /** Starting phase of the created rollout. */
  destinationPhase?: string;
  /** How long to wait before promoting. */
  wait?: string;
};

export type RepairRolloutRule = {
  /** Unique rule id within the Automation. */
  id?: string;
  /** Phases whose failed jobs are repaired. */
  phases?: string[];
  /** Repair phases (retry and/or rollback). */
  repairPhases?: clouddeploy.RepairPhaseConfig[];
  /** Job names to repair. Empty means all jobs. */
  jobs?: string[];
};

export type TimedPromoteReleaseRule = {
  /** Unique rule id within the Automation. */
  id?: string;
  /** Crontab schedule (for example `0 9 * * 1`). */
  schedule?: string;
  /** Destination stage id, or `@next`. */
  destinationTargetId?: string;
  /** Starting phase of the created rollout. */
  destinationPhase?: string;
  /** IANA time zone (for example `America/New_York`). */
  timeZone?: string;
};

export type AutomationRule = {
  /** Automatically advance a successful rollout. */
  advanceRolloutRule?: AdvanceRolloutRule;
  /** Automatically promote a release to the next (or specified) target. */
  promoteReleaseRule?: PromoteReleaseRule;
  /** Automatically repair a failed rollout. */
  repairRolloutRule?: RepairRolloutRule;
  /** Promote on a cron schedule. */
  timedPromoteReleaseRule?: TimedPromoteReleaseRule;
};

export type DeliveryPipelinesAutomationProps = {
  /**
   * Parent delivery pipeline. Full name
   * `projects/{project}/locations/{location}/deliveryPipelines/{deliveryPipeline}`
   * or the pipeline id (combined with `location`). Immutable — changing
   * it replaces the automation.
   */
  deliveryPipeline: string;
  /**
   * Region used when `deliveryPipeline` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Automation id (the `{automation}` segment). If omitted, a unique
   * RFC1035 name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the automation.
   */
  automationId?: string;
  /**
   * Email of the user-managed IAM service account that creates Cloud
   * Deploy release and rollout resources.
   */
  serviceAccount: string;
  /**
   * Resources the automation applies to.
   */
  selector: AutomationResourceSelector;
  /**
   * Automation rules. At least one is required.
   */
  rules: AutomationRule[];
  /**
   * Human-readable description. Max length 255 characters.
   */
  description?: string;
  /**
   * When true, the automation is deactivated.
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

export type DeliveryPipelinesAutomation = Resource<
  "GCP.CloudDeploy.DeliveryPipelinesAutomation",
  DeliveryPipelinesAutomationProps,
  {
    /** Full resource name. */
    name: string;
    /** Automation id (last path segment). */
    automationId: string;
    /** Parent delivery pipeline name. */
    deliveryPipeline: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Service account email. */
    serviceAccount: string | undefined;
    /** Resource selector. */
    selector: AutomationResourceSelector | undefined;
    /** Automation rules (output-only conditions stripped). */
    rules: AutomationRule[];
    /** Human-readable description. */
    description: string | undefined;
    /** Whether the automation is suspended. */
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
 * A Cloud Deploy automation attached to a delivery pipeline. Automations
 * promote releases, repair failed rollouts, and advance rollout phases
 * without a human in the loop.
 *
 * Changing `automationId`, `location`, or `deliveryPipeline` replaces
 * the automation. Rules, selector, service account, description, labels,
 * annotations, and `suspended` update in place.
 *
 * ### Creating an Automation
 * **Example:** Promote to the next stage
 * ```typescript
 * const automation = yield* GCP.CloudDeploy.DeliveryPipelinesAutomation("Promote", {
 *   deliveryPipeline: pipeline.name,
 *   serviceAccount: "deployer@my-project.iam.gserviceaccount.com",
 *   selector: { targets: [{ id: "*" }] },
 *   rules: [{ promoteReleaseRule: { id: "promote-release" } }],
 * });
 * ```
 *
 * **Example:** Timed promote
 * ```typescript
 * const automation = yield* GCP.CloudDeploy.DeliveryPipelinesAutomation("Nightly", {
 *   deliveryPipeline: pipeline.name,
 *   serviceAccount: "deployer@my-project.iam.gserviceaccount.com",
 *   selector: { targets: [{ id: "staging" }] },
 *   rules: [{
 *     timedPromoteReleaseRule: {
 *       id: "weekday-promote",
 *       schedule: "0 9 * * 1-5",
 *       timeZone: "America/New_York",
 *     },
 *   }],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Automation
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description and labels
 * ```typescript
 * const automation = yield* GCP.CloudDeploy.DeliveryPipelinesAutomation("Promote", {
 *   deliveryPipeline: pipeline.name,
 *   serviceAccount: "deployer@my-project.iam.gserviceaccount.com",
 *   selector: { targets: [{ id: "*" }] },
 *   rules: [{ promoteReleaseRule: { id: "promote-release" } }],
 *   description: "promote v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category CloudDeploy
 */
export const DeliveryPipelinesAutomation =
  Resource<DeliveryPipelinesAutomation>(
    "GCP.CloudDeploy.DeliveryPipelinesAutomation",
  );

const resourceName = (deliveryPipeline: string, automationId: string) =>
  `${deliveryPipeline}/automations/${automationId}`;

const toSelector = (
  value: clouddeploy.AutomationResourceSelector | undefined,
): AutomationResourceSelector | undefined =>
  value === undefined
    ? undefined
    : {
        targets: value.targets?.map((target) => ({
          id: target.id,
          labels: stringMap(target.labels),
        })),
      };

const toAttrs = (item: clouddeploy.Automation, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "automations");
  return {
    name,
    automationId: parsed.id,
    deliveryPipeline: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    serviceAccount: item.serviceAccount,
    selector: toSelector(item.selector),
    rules: stripAutomationRules(item.rules),
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
    .getProjectsLocationsDeliveryPipelinesAutomations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtNested(project, region, "deliveryPipelines/-", (parent) =>
    listLabeledPages(
      clouddeploy.listProjectsLocationsDeliveryPipelinesAutomations.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.automations,
      (item) => item.labels,
    ),
  );

export const DeliveryPipelinesAutomationProvider = () =>
  Provider.succeed(DeliveryPipelinesAutomation, {
    stables: [
      "name",
      "automationId",
      "deliveryPipeline",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location ?? env.region,
      );
      const previousParent = olds?.deliveryPipeline ?? output?.deliveryPipeline;
      const nextParent = expandParent(
        news.deliveryPipeline,
        env.project,
        location,
        "deliveryPipelines",
      );
      return replaceOnIdentity({
        previousId: olds?.automationId ?? output?.automationId,
        nextId: news.automationId ?? olds?.automationId ?? output?.automationId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: location,
        previousParent,
        nextParent,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const automationId = yield* toPhysicalId(
        id,
        olds?.automationId,
        output?.automationId,
        "automation",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const deliveryPipeline =
        output?.deliveryPipeline ??
        (olds?.deliveryPipeline
          ? expandParent(
              olds.deliveryPipeline,
              env.project,
              location,
              "deliveryPipelines",
            )
          : undefined);
      const name =
        output?.name ??
        (deliveryPipeline
          ? resourceName(deliveryPipeline, automationId)
          : undefined);
      if (name === undefined) return undefined;
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
      const automationId = yield* toPhysicalId(
        id,
        news.automationId,
        output?.automationId,
        "automation",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const deliveryPipeline = expandParent(
        news.deliveryPipeline,
        env.project,
        location,
        "deliveryPipelines",
      );
      const name = resourceName(deliveryPipeline, automationId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const desiredSuspended = news.suspended === true;
      const desiredRules = stripAutomationRules(news.rules);
      const desiredSelector = news.selector;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* clouddeploy
          .createProjectsLocationsDeliveryPipelinesAutomations({
            parent: deliveryPipeline,
            automationId,
            body: {
              serviceAccount: news.serviceAccount,
              selector: desiredSelector,
              rules: desiredRules,
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
        !sameText(current.serviceAccount, news.serviceAccount) &&
          "serviceAccount",
        fingerprint(toSelector(current.selector)) !==
          fingerprint(desiredSelector) && "selector",
        fingerprint(stripAutomationRules(current.rules)) !==
          fingerprint(desiredRules) && "rules",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* clouddeploy.patchProjectsLocationsDeliveryPipelinesAutomations(
            {
              name: current.name ?? name,
              updateMask: mask,
              body: {
                etag: current.etag,
                serviceAccount: news.serviceAccount,
                selector: desiredSelector,
                rules: desiredRules,
                description: news.description,
                suspended: desiredSuspended,
                annotations: desiredAnnotations,
                labels: desiredLabels,
              },
            },
          );
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
        .deleteProjectsLocationsDeliveryPipelinesAutomations({
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
