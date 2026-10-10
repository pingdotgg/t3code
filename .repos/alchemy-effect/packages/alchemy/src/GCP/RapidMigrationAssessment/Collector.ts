import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
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
  expectedAssetCountOf,
  fieldMask,
  isGoneState,
  isPausedState,
  isRegisteredState,
  listOwnedCollectors,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameNumber,
  sameText,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type CollectorState = rma.CollectorStateEnum | (string & {});

export type CollectorProps = {
  /**
   * Collector id (the `{collector}` segment of
   * `projects/{project}/locations/{location}/collectors/{collector}`).
   * If omitted, a unique RFC1035 name is generated. Immutable —
   * changing it replaces the collector.
   */
  collectorId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * collector. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name. Alchemy falls back to the generated
   * collector id.
   */
  displayName?: string;
  /**
   * User-specified description of the collector.
   */
  description?: string;
  /**
   * How many days to collect data.
   */
  collectionDays?: number;
  /**
   * Service account email used to ingest data to this collector.
   */
  serviceAccount?: string;
  /**
   * User-specified expected asset count.
   */
  expectedAssetCount?: number | string;
  /**
   * URI for the End User License Agreement accepted by the customer.
   */
  eulaUri?: string;
  /**
   * When true, pause an active collector. When false, resume a paused
   * collector. Omitted leaves pause state unchanged.
   */
  paused?: boolean;
  /**
   * When true, register a collector that is ready to use. Registration
   * is one-way; omitted or false leaves the collector unregistered.
   */
  registered?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Collector = Resource<
  "GCP.RapidMigrationAssessment.Collector",
  CollectorProps,
  {
    /** Full resource name. */
    name: string;
    /** Collector id (last path segment). */
    collectorId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User-specified description. */
    description: string | undefined;
    /** How many days to collect data. */
    collectionDays: number | undefined;
    /** Service account email used to ingest data. */
    serviceAccount: string | undefined;
    /** Expected asset count. */
    expectedAssetCount: string | undefined;
    /** EULA URI. */
    eulaUri: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported collector state. */
    state: string | undefined;
    /** Whether the collector is paused. */
    paused: boolean;
    /** Whether the collector has been registered. */
    registered: boolean;
    /** Client version reported by the appliance. */
    clientVersion: string | undefined;
    /** Cloud Storage bucket created with this collector. */
    bucket: string | undefined;
    /** Migration Center guest-OS scan reference. */
    guestOsScan: rma.GuestOsScan | undefined;
    /** Migration Center vSphere scan reference. */
    vsphereScan: rma.VSphereScan | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Rapid Migration Assessment collector that manages the on-prem
 * appliance gathering customer asset information.
 *
 * `collectorId` and `location` are immutable. Display name, description,
 * collection days, service account, expected asset count, EULA URI, and
 * labels update in place. Set `paused` to pause or resume, and
 * `registered` to register a collector that is ready to use.
 *
 * ### Creating a Collector
 * **Example:** Generated name
 * ```typescript
 * const collector = yield* GCP.RapidMigrationAssessment.Collector("OnPrem", {
 *   collectionDays: 30,
 *   expectedAssetCount: 100,
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Explicit id and service account
 * ```typescript
 * const collector = yield* GCP.RapidMigrationAssessment.Collector("OnPrem", {
 *   collectorId: "dc-east",
 *   location: "us-central1",
 *   displayName: "east datacenter",
 *   serviceAccount: "rma@my-project.iam.gserviceaccount.com",
 *   collectionDays: 14,
 * });
 * ```
 *
 * ### Updating a Collector
 * **Example:** Description, labels, and pause
 * ```typescript
 * const collector = yield* GCP.RapidMigrationAssessment.Collector("OnPrem", {
 *   displayName: "east datacenter v2",
 *   description: "paused for maintenance",
 *   paused: true,
 *   labels: { env: "prod", team: "migration" },
 * });
 * ```
 *
 * @resource
 * @category RapidMigrationAssessment
 */
export const Collector = Resource<Collector>(
  "GCP.RapidMigrationAssessment.Collector",
);

const resourceName = (project: string, location: string, collectorId: string) =>
  `${locationParent(project, location)}/collectors/${collectorId}`;

const toAttrs = (item: rma.Collector, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    collectorId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    description: item.description,
    collectionDays: item.collectionDays,
    serviceAccount: item.serviceAccount,
    expectedAssetCount: item.expectedAssetCount,
    eulaUri: item.eulaUri,
    labels: userLabels(item.labels),
    state: item.state,
    paused: isPausedState(item.state),
    registered: isRegisteredState(item.state),
    clientVersion: item.clientVersion,
    bucket: item.bucket,
    guestOsScan: item.guestOsScan,
    vsphereScan: item.vsphereScan,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : rma.getProjectsLocationsCollectors({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.map((item) =>
          item === undefined || isGoneState(item.state) ? undefined : item,
        ),
      );

const ignoreConflict = <A, R>(
  effect: Effect.Effect<
    A,
    | rma.PauseProjectsLocationsCollectorsError
    | rma.RegisterProjectsLocationsCollectorsError
    | rma.ResumeProjectsLocationsCollectorsError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTag(["Conflict", "BadRequest"], () =>
      Effect.succeed<A | undefined>(undefined),
    ),
  );

const applyDesiredState = (
  name: string,
  current: rma.Collector,
  news: CollectorProps,
) =>
  Effect.gen(function* () {
    let next = current;
    const state = next.state;

    if (news.registered === true && !isRegisteredState(state)) {
      const operation = yield* ignoreConflict(
        rma.registerProjectsLocationsCollectors({ name }),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation);
        next = yield* waitUntilExists(getByName(name), name);
      }
    }

    if (news.paused === true && !isPausedState(next.state)) {
      const operation = yield* ignoreConflict(
        rma.pauseProjectsLocationsCollectors({ name }),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation);
        next = yield* waitUntilExists(getByName(name), name);
      }
    }

    if (news.paused === false && isPausedState(next.state)) {
      const operation = yield* ignoreConflict(
        rma.resumeProjectsLocationsCollectors({ name }),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation);
        next = yield* waitUntilExists(getByName(name), name);
      }
    }

    return next;
  });

export const CollectorProvider = () =>
  Provider.succeed(Collector, {
    stables: ["name", "collectorId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.collectorId ?? output?.collectorId,
        nextId: news.collectorId ?? olds?.collectorId ?? output?.collectorId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const collectorId = yield* toPhysicalId(
        id,
        olds?.collectorId,
        output?.collectorId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, collectorId);
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
        const items = yield* listOwnedCollectors(env.project, env.region);
        return items
          .filter((item) => !isGoneState(item.state))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const collectorId = yield* toPhysicalId(
        id,
        news.collectorId,
        output?.collectorId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, collectorId);
      const displayName = news.displayName ?? collectorId;
      const expectedAssetCount = expectedAssetCountOf(news.expectedAssetCount);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let observed = yield* getByName(output?.name ?? name);

      if (observed === undefined) {
        const created = yield* rma
          .createProjectsLocationsCollectors({
            parent: locationParent(env.project, location),
            collectorId,
            body: {
              displayName,
              description: news.description,
              collectionDays: news.collectionDays,
              serviceAccount: news.serviceAccount,
              expectedAssetCount,
              eulaUri: news.eulaUri,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        observed = yield* waitUntilExists(getByName(name), name);
      }

      let current = observed ?? (yield* new ResourceNotResolved({ name }));
      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      ).pipe(
        Effect.catchTag("GCP.RapidMigrationAssessment.ResourceNotReady", () =>
          Effect.succeed(current),
        ),
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.displayName, displayName) && "displayName",
        news.description !== undefined &&
          !sameText(current.description, news.description) &&
          "description",
        news.collectionDays !== undefined &&
          !sameNumber(current.collectionDays, news.collectionDays) &&
          "collectionDays",
        news.serviceAccount !== undefined &&
          !sameText(current.serviceAccount, news.serviceAccount) &&
          "serviceAccount",
        expectedAssetCount !== undefined &&
          !sameText(current.expectedAssetCount, expectedAssetCount) &&
          "expectedAssetCount",
        news.eulaUri !== undefined &&
          !sameText(current.eulaUri, news.eulaUri) &&
          "eulaUri",
      ]);

      if (mask.length > 0) {
        const operation = yield* rma.patchProjectsLocationsCollectors({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            displayName,
            description: news.description,
            collectionDays: news.collectionDays,
            serviceAccount: news.serviceAccount,
            expectedAssetCount,
            eulaUri: news.eulaUri,
            labels: desiredLabels,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      current = yield* applyDesiredState(current.name ?? name, current, news);
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* rma
        .deleteProjectsLocationsCollectors({ name: output.name })
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
