import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  DEFAULT_ZONE,
  MAX_MULTICAST_NAME_LENGTH,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  linkKey,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  toNamedResource,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "multicastGroupConsumerActivations";

export type MulticastLogConfig = {
  /**
   * Export multicast group-consumer activity to Cloud Logging.
   * @default false
   */
  enabled?: boolean;
};

export type MulticastGroupConsumerActivationProps = {
  /**
   * Activation id (the `{multicastGroupConsumerActivation}` segment of
   * `projects/{project}/locations/{location}/multicastGroupConsumerActivations/{multicastGroupConsumerActivation}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be at most 48 characters. Immutable — changing it
   * replaces the activation.
   */
  multicastGroupConsumerActivationId?: string;
  /**
   * Zone of the activation (`us-central1-a`, …). Immutable — changing
   * it replaces the activation. `US-CENTRAL1-A` is accepted and
   * normalized to `us-central1-a`.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Multicast consumer association in the same zone
   * (`projects/{project}/locations/{location}/multicastConsumerAssociations/{association}`).
   * Immutable — changing it replaces the activation.
   */
  multicastConsumerAssociation: string;
  /**
   * Multicast group range activation in the same zone
   * (`projects/{project}/locations/{location}/multicastGroupRangeActivations/{activation}`).
   * Immutable — changing it replaces the activation.
   */
  multicastGroupRangeActivation: string;
  /**
   * Deprecated multicast group resource name. Prefer
   * `multicastGroupRangeActivation`.
   */
  multicastGroup?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Logging options for this activation.
   */
  logConfig?: MulticastLogConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type MulticastGroupConsumerActivation = Resource<
  "GCP.NetworkServices.MulticastGroupConsumerActivation",
  MulticastGroupConsumerActivationProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/multicastGroupConsumerActivations/{multicastGroupConsumerActivation}`. */
    name: string;
    /** Activation id (last path segment). */
    multicastGroupConsumerActivationId: string;
    /** Project id. */
    project: string;
    /** Zone id (`us-central1-a`, …). */
    location: string;
    /** Attached multicast consumer association. */
    multicastConsumerAssociation: string | undefined;
    /** Attached multicast group range activation. */
    multicastGroupRangeActivation: string | undefined;
    /** Deprecated multicast group name, if set. */
    multicastGroup: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** Logging configuration. */
    logConfig: MulticastLogConfig | undefined;
    /** Deprecated resource-state enum. */
    resourceState: string | undefined;
    /** Nested multicast resource state. */
    state: string | undefined;
    /** Google-generated UUID. */
    uniqueId: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A multicast group consumer activation lets VMs in an associated
 * consumer VPC join a multicast group range in the same zone.
 *
 * Changing `multicastGroupConsumerActivationId`, `location`,
 * `multicastConsumerAssociation`, or `multicastGroupRangeActivation`
 * replaces the activation. Description, labels, and log config update
 * in place.
 *
 * ### Creating a MulticastGroupConsumerActivation
 * **Example:** Activate a group range for a consumer VPC
 * ```typescript
 * const activation = yield* GCP.NetworkServices.MulticastGroupConsumerActivation(
 *   "Join",
 *   {
 *     location: association.location,
 *     multicastConsumerAssociation: association.name,
 *     multicastGroupRangeActivation: rangeActivation.name,
 *     logConfig: { enabled: true },
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const MulticastGroupConsumerActivation =
  Resource<MulticastGroupConsumerActivation>(
    "GCP.NetworkServices.MulticastGroupConsumerActivation",
  );

const toAssociation = (
  project: string,
  location: string,
  value: string | undefined,
) =>
  value
    ? toNamedResource(project, location, "multicastConsumerAssociations", value)
    : undefined;

const toRangeActivation = (
  project: string,
  location: string,
  value: string | undefined,
) =>
  value
    ? toNamedResource(
        project,
        location,
        "multicastGroupRangeActivations",
        value,
      )
    : undefined;

const toGroup = (
  project: string,
  location: string,
  value: string | undefined,
) =>
  value
    ? toNamedResource(project, location, "multicastGroups", value)
    : undefined;

const toLogConfig = (
  config: MulticastLogConfig | networkservices.MulticastLogConfig | undefined,
): MulticastLogConfig | undefined => {
  if (config === undefined) return undefined;
  return { enabled: config.enabled };
};

const toAttrs = (
  activation: networkservices.MulticastGroupConsumerActivation,
  project: string,
) => {
  const name = activation.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_ZONE);
  const location = parsed.location || DEFAULT_ZONE;
  const proj = parsed.project || project;
  return {
    name,
    multicastGroupConsumerActivationId: parsed.id,
    project: proj,
    location,
    multicastConsumerAssociation: toAssociation(
      proj,
      location,
      activation.multicastConsumerAssociation,
    ),
    multicastGroupRangeActivation: toRangeActivation(
      proj,
      location,
      activation.multicastGroupRangeActivation,
    ),
    multicastGroup: toGroup(proj, location, activation.multicastGroup),
    description: activation.description,
    logConfig: toLogConfig(activation.logConfig),
    resourceState: activation.resourceState,
    state: activation.state?.state,
    uniqueId: activation.uniqueId,
    labels: userLabels(activation.labels),
    createTime: activation.createTime,
    updateTime: activation.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsMulticastGroupConsumerActivations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const MulticastGroupConsumerActivationProvider = () =>
  Provider.succeed(MulticastGroupConsumerActivation, {
    stables: [
      "name",
      "multicastGroupConsumerActivationId",
      "project",
      "location",
      "multicastConsumerAssociation",
      "multicastGroupRangeActivation",
      "uniqueId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.multicastGroupConsumerActivationId ??
        output?.multicastGroupConsumerActivationId;
      const nextId = news.multicastGroupConsumerActivationId
        ? rfc1035(
            news.multicastGroupConsumerActivationId,
            "mcast-gca",
            MAX_MULTICAST_NAME_LENGTH,
          )
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const previousAssociation = linkKey(
        olds?.multicastConsumerAssociation ??
          output?.multicastConsumerAssociation,
      );
      const nextAssociation = linkKey(news.multicastConsumerAssociation);
      const previousRange = linkKey(
        olds?.multicastGroupRangeActivation ??
          output?.multicastGroupRangeActivation,
      );
      const nextRange = linkKey(news.multicastGroupRangeActivation);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousAssociation.length > 0 &&
          previousAssociation !== nextAssociation) ||
        (previousRange.length > 0 && previousRange !== nextRange)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const multicastGroupConsumerActivationId = yield* toPhysicalId(
        id,
        olds?.multicastGroupConsumerActivationId,
        output?.multicastGroupConsumerActivationId,
        "mcast-gca",
        MAX_MULTICAST_NAME_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name =
        output?.name ??
        resourceName(
          env.project,
          location,
          COLLECTION,
          multicastGroupConsumerActivationId,
        );
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
        const items = yield* collectPages(
          networkservices.listProjectsLocationsMulticastGroupConsumerActivations.pages(
            {
              parent: parentOf(env.project, "-"),
              pageSize: 1000,
            },
          ),
          (page) => page.multicastGroupConsumerActivations,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const multicastGroupConsumerActivationId = yield* toPhysicalId(
        id,
        news.multicastGroupConsumerActivationId,
        output?.multicastGroupConsumerActivationId,
        "mcast-gca",
        MAX_MULTICAST_NAME_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        multicastGroupConsumerActivationId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const multicastConsumerAssociation = toAssociation(
        env.project,
        location,
        news.multicastConsumerAssociation,
      );
      const multicastGroupRangeActivation = toRangeActivation(
        env.project,
        location,
        news.multicastGroupRangeActivation,
      );
      const multicastGroup = toGroup(
        env.project,
        location,
        news.multicastGroup,
      );
      const logConfig = toLogConfig(news.logConfig);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsMulticastGroupConsumerActivations({
            parent: parentOf(env.project, location),
            multicastGroupConsumerActivationId,
            body: {
              description: news.description,
              labels: desiredLabels,
              multicastConsumerAssociation,
              multicastGroupRangeActivation,
              multicastGroup,
              logConfig,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observed = toAttrs(current, env.project);
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const updateMask = changedFields([
        ["labels", labelsChanged],
        [
          "description",
          (current.description ?? "") !== (news.description ?? ""),
        ],
        ["logConfig", !sameJson(observed.logConfig, logConfig)],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsMulticastGroupConsumerActivations(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                description: news.description,
                logConfig,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsMulticastGroupConsumerActivations({
          name: output.name,
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
