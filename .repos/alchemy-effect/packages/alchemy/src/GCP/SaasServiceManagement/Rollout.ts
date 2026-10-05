import * as saasservicemgmt from "@distilled.cloud/gcp/saasservicemgmt_v1";
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
  ResourceNotResolved,
  collectPages,
  expandName,
  fieldMask,
  fingerprint,
  hasAlchemyLabelKeys,
  lastSegment,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameRef,
  toPhysicalId,
  userAnnotations,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "rollouts";

export type RolloutControlAction =
  | saasservicemgmt.RolloutControlActionEnum
  | (string & {});

export type RolloutControl = {
  action?: RolloutControlAction;
  runParams?: { retryFailedOperations?: boolean };
};

export type RolloutStats = {
  operationsByState?: Array<{ count?: number; group?: string }>;
  estimatedTotalUnitCount?: string;
};

export type RolloutProps = {
  /**
   * Rollout id (the `{rollout_id}` segment of
   * `projects/{project}/locations/{location}/rollouts/{rollout_id}`). If
   * omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the rollout.
   */
  rolloutId?: string;
  /**
   * Region of the rollout (`us-central1`, …). Immutable — changing it
   * replaces the rollout. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * RolloutKind this rollout follows. Accepts a rollout kind id or a
   * full resource name. Immutable — changing it replaces the rollout.
   */
  rolloutKind?: string;
  /**
   * Release rolled out to target units. Mutually exclusive with
   * `flagRelease`. Immutable — changing it replaces the rollout.
   */
  release?: string;
  /**
   * Flag release rolled out to target units. Mutually exclusive with
   * `release`. Immutable — changing it replaces the rollout.
   */
  flagRelease?: string;
  /**
   * CEL filter reducing the eligible unit population for this rollout.
   */
  unitFilter?: string;
  /**
   * Orchestration strategy override. If omitted, the RolloutKind
   * strategy is used.
   */
  rolloutOrchestrationStrategy?: string;
  /**
   * Requested execution change (`ROLLOUT_ACTION_RUN`,
   * `ROLLOUT_ACTION_PAUSE`, `ROLLOUT_ACTION_CANCEL`).
   */
  control?: RolloutControl;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Unstructured annotations preserved across updates.
   */
  annotations?: Record<string, string>;
};

export type Rollout = Resource<
  "GCP.SaasServiceManagement.Rollout",
  RolloutProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/rollouts/{rollout_id}`. */
    name: string;
    /** Rollout id (last path segment). */
    rolloutId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** RolloutKind resource name. */
    rolloutKind: string | undefined;
    /** RolloutKind id (last path segment). */
    rolloutKindId: string | undefined;
    /** Release resource name. */
    release: string | undefined;
    /** Release id (last path segment). */
    releaseId: string | undefined;
    /** Flag release resource name. */
    flagRelease: string | undefined;
    /** CEL unit filter. */
    unitFilter: string | undefined;
    /** Effective unit filter snapshotted at start. */
    effectiveUnitFilter: string | undefined;
    /** Orchestration strategy. */
    rolloutOrchestrationStrategy: string | undefined;
    /** Requested control action. */
    control: RolloutControl | undefined;
    /** Lifecycle state. */
    state: string | undefined;
    /** Human-readable last-transition message. */
    stateMessage: string | undefined;
    /** Progress stats. */
    stats: RolloutStats | undefined;
    /** Root rollout this one stems from. */
    rootRollout: string | undefined;
    /** Direct parent rollout. */
    parentRollout: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Server UUID. */
    uid: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An App Lifecycle Manager rollout — one execution of a RolloutKind
 * against a Release (or FlagRelease).
 *
 * `rolloutId`, `location`, `rolloutKind`, `release`, and `flagRelease`
 * replace the rollout. Unit filter, strategy override, control action,
 * labels, and annotations update in place. Requests to pause or cancel
 * are only accepted while the rollout is non-terminal.
 *
 * ### Creating a Rollout
 * **Example:** Roll a release
 * ```typescript
 * const rollout = yield* GCP.SaasServiceManagement.Rollout("Wave1", {
 *   rolloutKind: kind.name,
 *   release: release.name,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Rollout
 * **Example:** Pause
 * ```typescript
 * const rollout = yield* GCP.SaasServiceManagement.Rollout("Wave1", {
 *   rolloutId: rollout.rolloutId,
 *   rolloutKind: kind.name,
 *   release: release.name,
 *   control: { action: "ROLLOUT_ACTION_PAUSE" },
 * });
 * ```
 *
 * @resource
 * @category SaasServiceManagement
 */
export const Rollout = Resource<Rollout>("GCP.SaasServiceManagement.Rollout");

const toAttrs = (item: saasservicemgmt.Rollout, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    rolloutId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    rolloutKind: item.rolloutKind,
    rolloutKindId: item.rolloutKind ? lastSegment(item.rolloutKind) : undefined,
    release: item.release,
    releaseId: item.release ? lastSegment(item.release) : undefined,
    flagRelease: item.flagRelease,
    unitFilter: item.unitFilter,
    effectiveUnitFilter: item.effectiveUnitFilter,
    rolloutOrchestrationStrategy: item.rolloutOrchestrationStrategy,
    control: item.control
      ? {
          action: item.control.action,
          runParams: item.control.runParams,
        }
      : undefined,
    state: item.state,
    stateMessage: item.stateMessage,
    stats: item.stats,
    rootRollout: item.rootRollout,
    parentRollout: item.parentRollout,
    labels: userLabels(item.labels),
    annotations: userAnnotations(item.annotations),
    uid: item.uid,
    etag: item.etag,
    createTime: item.createTime,
    updateTime: item.updateTime,
    startTime: item.startTime,
    endTime: item.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : saasservicemgmt
        .getProjectsLocationsRollouts({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location: string) =>
  collectPages(
    saasservicemgmt.listProjectsLocationsRollouts.pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    }),
    (page) => page.rollouts,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelKeys(item.labels)),
    ),
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : collectPages(
            saasservicemgmt.listProjectsLocationsRollouts.pages({
              parent: parentOf(project, location),
              pageSize: 1000,
            }),
            (page) => page.rollouts,
          ).pipe(
            Effect.map((fallback) =>
              fallback.filter((item) => hasAlchemyLabelKeys(item.labels)),
            ),
          ),
    ),
  );

export const RolloutProvider = () =>
  Provider.succeed(Rollout, {
    stables: [
      "name",
      "rolloutId",
      "project",
      "location",
      "rolloutKindId",
      "releaseId",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.rolloutId ?? output?.rolloutId,
        nextId: news.rolloutId ?? olds?.rolloutId ?? output?.rolloutId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra:
          (news.rolloutKind !== undefined &&
            !sameRef(
              olds?.rolloutKind ?? output?.rolloutKind,
              news.rolloutKind,
            )) ||
          (news.release !== undefined &&
            !sameRef(olds?.release ?? output?.release, news.release)) ||
          (news.flagRelease !== undefined &&
            (olds?.flagRelease ?? output?.flagRelease ?? "") !==
              news.flagRelease),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const rolloutId = yield* toPhysicalId(
        id,
        olds?.rolloutId,
        output?.rolloutId,
        "rlo",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, rolloutId);
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
      const rolloutId = yield* toPhysicalId(
        id,
        news.rolloutId,
        output?.rolloutId,
        "rlo",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, COLLECTION, rolloutId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const rolloutKind =
        news.rolloutKind === undefined
          ? undefined
          : expandName(news.rolloutKind, env.project, location, "rolloutKinds");
      const release =
        news.release === undefined
          ? undefined
          : expandName(news.release, env.project, location, "releases");
      const annotations = news.annotations;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* saasservicemgmt
          .createProjectsLocationsRollouts({
            parent: parentOf(env.project, location),
            rolloutId,
            body: {
              rolloutKind,
              release,
              flagRelease: news.flagRelease,
              unitFilter: news.unitFilter,
              rolloutOrchestrationStrategy: news.rolloutOrchestrationStrategy,
              control: news.control,
              labels: desiredLabels,
              annotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const annotationsChanged =
        annotations !== undefined &&
        fingerprint(userAnnotations(current.annotations)) !==
          fingerprint(annotations);
      const filterChanged =
        news.unitFilter !== undefined &&
        (current.unitFilter ?? "") !== news.unitFilter;
      const strategyChanged =
        news.rolloutOrchestrationStrategy !== undefined &&
        (current.rolloutOrchestrationStrategy ?? "") !==
          news.rolloutOrchestrationStrategy;
      const controlChanged =
        news.control !== undefined &&
        fingerprint(current.control) !== fingerprint(news.control);
      const mask = fieldMask([
        labelsChanged && "labels",
        annotationsChanged && "annotations",
        filterChanged && "unitFilter",
        strategyChanged && "rolloutOrchestrationStrategy",
        controlChanged && "control",
      ]);

      if (mask.length > 0) {
        current = yield* saasservicemgmt.patchProjectsLocationsRollouts({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            etag: current.etag,
            unitFilter: news.unitFilter,
            rolloutOrchestrationStrategy: news.rolloutOrchestrationStrategy,
            control: news.control,
            labels: desiredLabels,
            annotations,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* saasservicemgmt
        .deleteProjectsLocationsRollouts({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
