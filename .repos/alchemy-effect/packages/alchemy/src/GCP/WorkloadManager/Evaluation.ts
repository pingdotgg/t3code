import * as workloadmanager from "@distilled.cloud/gcp/workloadmanager_v1";
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
  sameStringList,
  sameText,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type GceInstanceFilter = {
  /**
   * Service accounts whose associated Compute Engine instances are
   * included in the evaluation.
   */
  serviceAccounts?: string[];
};

export type ResourceFilter = {
  /**
   * Evaluation scopes. Format `projects/{project}`, `folders/{folder}`,
   * or `organizations/{organization}`. Bare project ids are expanded.
   * Defaults to the current project.
   */
  scopes?: string[];
  /**
   * Labels that must exist on a resource for it to be included
   * (for example VM instance labels).
   */
  inclusionLabels?: Record<string, string>;
  /**
   * Filter Compute Engine instances by service account.
   */
  gceInstanceFilter?: GceInstanceFilter;
  /**
   * Resource-id patterns. A pattern of `prod-cluster` matches resources
   * whose id contains that substring.
   */
  resourceIdPatterns?: string[];
};

export type BigQueryDestination = {
  /**
   * Destination dataset for evaluation results.
   */
  destinationDataset?: string;
  /**
   * When true, a new results table is created for each Execution.
   */
  createNewResultsTable?: boolean;
};

export type EvaluationType =
  | workloadmanager.EvaluationEvaluationTypeEnum
  | (string & {});

export type EvaluationProps = {
  /**
   * Evaluation id (the `{evaluation}` segment of
   * `projects/{project}/locations/{location}/evaluations/{evaluation}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the evaluation.
   */
  evaluationId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the evaluation. `US-CENTRAL1` is accepted and normalized
   * to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Scope of Cloud resources to evaluate. When omitted, the current
   * project is used as the sole scope.
   */
  resourceFilter?: ResourceFilter;
  /**
   * Rule names applied by this evaluation. List available names with
   * `listProjectsLocationsRules`.
   */
  ruleNames?: string[];
  /**
   * Customer-managed encryption key
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   * Immutable — changing it replaces the evaluation.
   */
  kmsKey?: string;
  /**
   * BigQuery destination for detailed evaluation results.
   */
  bigQueryDestination?: BigQueryDestination;
  /**
   * Workload type (`SAP`, `SQL_SERVER`, `OTHER`, …).
   */
  evaluationType?: EvaluationType;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Crontab schedule. Workload Manager only accepts a fixed set of
   * cadences (hourly, every 6 or 12 hours, daily, weekly, every 14
   * days, monthly).
   */
  schedule?: string;
  /**
   * Cloud Storage bucket that holds custom rules.
   */
  customRulesBucket?: string;
};

export type Evaluation = Resource<
  "GCP.WorkloadManager.Evaluation",
  EvaluationProps,
  {
    /** Full resource name. */
    name: string;
    /** Evaluation id (last path segment). */
    evaluationId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Human-readable description. */
    description: string | undefined;
    /** Resource filter. */
    resourceFilter: ResourceFilter | undefined;
    /** Applied rule names. */
    ruleNames: string[];
    /** Customer-managed encryption key. */
    kmsKey: string | undefined;
    /** Lifecycle state of the evaluation resource. */
    resourceStatus: string | undefined;
    /** BigQuery destination. */
    bigQueryDestination: BigQueryDestination | undefined;
    /** Workload type. */
    evaluationType: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Crontab schedule. */
    schedule: string | undefined;
    /** Custom-rules bucket. */
    customRulesBucket: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Workload Manager evaluation — a named set of best-practice rules
 * validated against a scope of Cloud resources (SAP, SQL Server, or
 * custom).
 *
 * Changing `evaluationId`, `location`, or `kmsKey` replaces the
 * evaluation. Description, labels, resource filter, rule names,
 * schedule, custom-rules bucket, BigQuery destination, and
 * `evaluationType` update in place.
 *
 * ### Creating an Evaluation
 * **Example:** Generated name
 * ```typescript
 * const evaluation = yield* GCP.WorkloadManager.Evaluation("SapBest", {
 *   evaluationType: "SAP",
 *   ruleNames: ["sap-hana"],
 *   resourceFilter: { scopes: ["projects/my-project"] },
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const evaluation = yield* GCP.WorkloadManager.Evaluation("SapBest", {
 *   evaluationId: "nightly-sap",
 *   evaluationType: "SAP",
 *   ruleNames: ["sap-hana"],
 *   description: "nightly SAP scan",
 * });
 * ```
 *
 * ### Updating an Evaluation
 * **Example:** Description and labels
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const evaluation = yield* GCP.WorkloadManager.Evaluation("SapBest", {
 *   evaluationType: "SAP",
 *   ruleNames: ["sap-hana"],
 *   description: "nightly SAP scan v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category WorkloadManager
 */
export const Evaluation = Resource<Evaluation>(
  "GCP.WorkloadManager.Evaluation",
);

const resourceName = (
  project: string,
  location: string,
  evaluationId: string,
) => `projects/${project}/locations/${location}/evaluations/${evaluationId}`;

const expandScope = (value: string, project: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/")) return trimmed;
  return `projects/${trimmed.length > 0 ? trimmed : project}`;
};

const toFilter = (
  filter: workloadmanager.ResourceFilter | undefined,
): ResourceFilter | undefined =>
  filter === undefined
    ? undefined
    : {
        scopes: filter.scopes,
        inclusionLabels: stringMap(filter.inclusionLabels),
        gceInstanceFilter: filter.gceInstanceFilter,
        resourceIdPatterns: filter.resourceIdPatterns,
      };

const toBigQuery = (
  destination: workloadmanager.BigQueryDestination | undefined,
): BigQueryDestination | undefined =>
  destination === undefined
    ? undefined
    : {
        destinationDataset: destination.destinationDataset,
        createNewResultsTable: destination.createNewResultsTable,
      };

const desiredFilter = (
  filter: ResourceFilter | undefined,
  project: string,
): workloadmanager.ResourceFilter => ({
  scopes: (filter?.scopes === undefined || filter.scopes.length === 0
    ? [`projects/${project}`]
    : filter.scopes
  ).map((scope) => expandScope(scope, project)),
  inclusionLabels: filter?.inclusionLabels,
  gceInstanceFilter: filter?.gceInstanceFilter,
  resourceIdPatterns: filter?.resourceIdPatterns,
});

const toAttrs = (
  item: workloadmanager.Evaluation,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "evaluations", region);
  return {
    name,
    evaluationId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: item.description,
    resourceFilter: toFilter(item.resourceFilter),
    ruleNames: item.ruleNames ?? [],
    kmsKey: item.kmsKey,
    resourceStatus: item.resourceStatus?.state,
    bigQueryDestination: toBigQuery(item.bigQueryDestination),
    evaluationType: item.evaluationType,
    labels: userLabels(item.labels),
    schedule: item.schedule,
    customRulesBucket: item.customRulesBucket,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  workloadmanager
    .getProjectsLocationsEvaluations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      workloadmanager.listProjectsLocationsEvaluations.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.evaluations,
      (item) => item.labels,
    ),
  );

export const EvaluationProvider = () =>
  Provider.succeed(Evaluation, {
    stables: [
      "name",
      "evaluationId",
      "project",
      "location",
      "kmsKey",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.evaluationId ?? output?.evaluationId,
        nextId: news.evaluationId ?? olds?.evaluationId ?? output?.evaluationId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (olds?.kmsKey ?? output?.kmsKey) !== undefined &&
          news.kmsKey !== undefined &&
          (olds?.kmsKey ?? output?.kmsKey) !== news.kmsKey,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const evaluationId = yield* toPhysicalId(
        id,
        olds?.evaluationId,
        output?.evaluationId,
        "evaluation",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, evaluationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const evaluationId = yield* toPhysicalId(
        id,
        news.evaluationId,
        output?.evaluationId,
        "evaluation",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, evaluationId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const resourceFilter = desiredFilter(news.resourceFilter, env.project);
      const ruleNames = news.ruleNames;
      const body: workloadmanager.Evaluation = {
        description: news.description,
        resourceFilter,
        ruleNames,
        kmsKey: news.kmsKey,
        bigQueryDestination: news.bigQueryDestination,
        evaluationType: news.evaluationType,
        labels: desiredLabels,
        schedule: news.schedule,
        customRulesBucket: news.customRulesBucket,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* workloadmanager
          .createProjectsLocationsEvaluations({
            parent: parentOf(env.project, location),
            evaluationId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.resourceStatus?.state,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.description, news.description) && "description",
        fingerprint(toFilter(current.resourceFilter)) !==
          fingerprint(toFilter(resourceFilter)) && "resourceFilter",
        !sameStringList(current.ruleNames, ruleNames) && "ruleNames",
        fingerprint(toBigQuery(current.bigQueryDestination)) !==
          fingerprint(news.bigQueryDestination) && "bigQueryDestination",
        !sameText(current.evaluationType, news.evaluationType) &&
          "evaluationType",
        !sameText(current.schedule, news.schedule) && "schedule",
        !sameText(current.customRulesBucket, news.customRulesBucket) &&
          "customRulesBucket",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* workloadmanager.patchProjectsLocationsEvaluations({
            name: current.name ?? name,
            updateMask: mask,
            body,
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.resourceStatus?.state,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* workloadmanager
        .deleteProjectsLocationsEvaluations({
          name: output.name,
          force: true,
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
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
