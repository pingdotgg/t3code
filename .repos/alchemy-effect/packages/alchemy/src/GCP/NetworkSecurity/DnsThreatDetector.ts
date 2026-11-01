import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
  DEFAULT_GLOBAL,
  canonicalizeLink,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  rfc1035,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitUntilGone,
  waitUntilPresent,
  NetworksecurityNotResolved,
} from "./internal.ts";

const COLLECTION = "dnsThreatDetectors";
const DEFAULT_PROVIDER = "INFOBLOX";

export type DnsThreatDetectorProvider =
  | networksecurity.DnsThreatDetectorProviderEnum
  | (string & {});

export type DnsThreatDetectorProps = {
  /**
   * DnsThreatDetector id (the `{dnsThreatDetector}` segment of
   * `projects/{project}/locations/global/dnsThreatDetectors/{dnsThreatDetector}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the detector. A project
   * may have only one DNS threat detector.
   */
  dnsThreatDetectorId?: string;
  /**
   * Location. The only supported value is `global`. Immutable —
   * changing it replaces the detector.
   * @default "global"
   */
  location?: string;
  /**
   * DNS threat analysis provider. Currently only `INFOBLOX` is
   * supported. Immutable — changing it replaces the detector.
   * @default "INFOBLOX"
   */
  provider?: DnsThreatDetectorProvider;
  /**
   * VPC network resource names that this detector should not monitor,
   * e.g. `projects/PROJECT_ID/global/networks/NETWORK_NAME`.
   */
  excludedNetworks?: string[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type DnsThreatDetector = Resource<
  "GCP.NetworkSecurity.DnsThreatDetector",
  DnsThreatDetectorProps,
  {
    /** Full resource name `projects/{project}/locations/global/dnsThreatDetectors/{dnsThreatDetector}`. */
    name: string;
    /** DnsThreatDetector id (last path segment). */
    dnsThreatDetectorId: string;
    /** Project id. */
    project: string;
    /** Location id — always `"global"`. */
    location: string;
    /** Threat analysis provider (`INFOBLOX`). */
    provider: string | undefined;
    /** VPC networks excluded from monitoring. */
    excludedNetworks: string[];
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
 * A DNS threat detector that sends VPC DNS query logs to Infoblox for
 * analysis. By default every VPC in the project is monitored; pass
 * `excludedNetworks` to skip specific networks.
 *
 * A project may have only one detector. Changing `dnsThreatDetectorId`,
 * `location`, or `provider` replaces the resource. Labels and
 * `excludedNetworks` update in place.
 *
 * ### Creating a DnsThreatDetector
 * **Example:** Monitor every VPC
 * ```typescript
 * const detector = yield* GCP.NetworkSecurity.DnsThreatDetector("Armor", {
 *   provider: "INFOBLOX",
 * });
 * ```
 *
 * **Example:** Exclude a network
 * ```typescript
 * const detector = yield* GCP.NetworkSecurity.DnsThreatDetector("Armor", {
 *   provider: "INFOBLOX",
 *   excludedNetworks: [
 *     `projects/${project}/global/networks/${vpc.networkName}`,
 *   ],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const DnsThreatDetector = Resource<DnsThreatDetector>(
  "GCP.NetworkSecurity.DnsThreatDetector",
);

const resourceName = (
  project: string,
  location: string,
  dnsThreatDetectorId: string,
) =>
  `projects/${project}/locations/${location}/dnsThreatDetectors/${dnsThreatDetectorId}`;

const desiredProvider = (news: DnsThreatDetectorProps) =>
  (news.provider ?? DEFAULT_PROVIDER).toUpperCase();

const toExcluded = (networks: readonly string[] | undefined) =>
  (networks ?? []).map((network) => canonicalizeLink(network)).filter(Boolean);

const toAttrs = (
  detector: networksecurity.DnsThreatDetector,
  project: string,
) => {
  const name = detector.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    dnsThreatDetectorId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    provider: detector.provider,
    excludedNetworks: toExcluded(detector.excludedNetworks),
    labels: userLabels(detector.labels),
    createTime: detector.createTime,
    updateTime: detector.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsDnsThreatDetectors({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DnsThreatDetectorProvider = () =>
  Provider.succeed(DnsThreatDetector, {
    stables: [
      "name",
      "dnsThreatDetectorId",
      "project",
      "location",
      "provider",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.dnsThreatDetectorId ?? output?.dnsThreatDetectorId;
      const nextId = news.dnsThreatDetectorId
        ? rfc1035(news.dnsThreatDetectorId, "dns-threat-detector")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const previousProvider = (
        olds?.provider ??
        output?.provider ??
        DEFAULT_PROVIDER
      ).toUpperCase();
      const nextProvider = desiredProvider(news);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousProvider !== nextProvider
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dnsThreatDetectorId = yield* toPhysicalId(
        id,
        olds?.dnsThreatDetectorId,
        output?.dnsThreatDetectorId,
        "dns-threat-detector",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, dnsThreatDetectorId);
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
          networksecurity.listProjectsLocationsDnsThreatDetectors.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.dnsThreatDetectors,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dnsThreatDetectorId = yield* toPhysicalId(
        id,
        news.dnsThreatDetectorId,
        output?.dnsThreatDetectorId,
        "dns-threat-detector",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, dnsThreatDetectorId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const provider = desiredProvider(news);
      const excludedNetworks = toExcluded(news.excludedNetworks);

      let current = yield* getByName(name);

      if (current === undefined) {
        yield* networksecurity
          .createProjectsLocationsDnsThreatDetectors({
            parent: parentOf(env.project, location),
            dnsThreatDetectorId,
            body: {
              provider,
              labels: desiredLabels,
              excludedNetworks,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* waitUntilPresent(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new NetworksecurityNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const excludedChanged = !sameStringList(
        current.excludedNetworks,
        excludedNetworks,
      );
      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["excludedNetworks", excludedChanged],
      ]);

      if (updateMask.length > 0) {
        yield* networksecurity.patchProjectsLocationsDnsThreatDetectors({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            excludedNetworks,
          },
        });
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* networksecurity
        .deleteProjectsLocationsDnsThreatDetectors({ name: output.name })
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
