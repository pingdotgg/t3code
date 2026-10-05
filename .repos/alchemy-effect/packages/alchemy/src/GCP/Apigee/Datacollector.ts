import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  createOwnership,
  dcCollectorId,
  defaultOrgName,
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  listOrgNames,
  orgIdOf,
  orgNameOf,
  ownedBy,
  parseDescription,
} from "./operations.ts";

export type DataCollectorType =
  | apigee.GoogleCloudApigeeV1DataCollectorTypeEnum
  | (string & {});

export type DatacollectorProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the collector.
   */
  organization?: string;
  /**
   * Data collector id (the `{data_collector}` segment of
   * `organizations/{org}/datacollectors/{data_collector}`). Must begin with
   * `dc_` and contain only letters, numbers, and underscores. If omitted,
   * a unique `dc_` name is generated. Immutable — changing it replaces the
   * collector.
   */
  dataCollectorId?: string;
  /**
   * Human-readable description. Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Type of data this collector records. Immutable — changing it replaces
   * the collector.
   * @default "STRING"
   */
  type?: DataCollectorType;
};

export type Datacollector = Resource<
  "GCP.Apigee.Datacollector",
  DatacollectorProps,
  {
    /** Full resource name `organizations/{org}/datacollectors/{id}`. */
    name: string;
    /** Data collector id (last path segment). */
    dataCollectorId: string;
    /** Apigee organization id. */
    organization: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Collector value type. */
    type: string | undefined;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee data collector used to capture custom analytics dimensions.
 *
 * Apigee collectors have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Name and type are identity — changing
 * `dataCollectorId` or `type` replaces the collector. Description updates
 * in place.
 *
 * ### Creating a Data Collector
 * **Example:** Generated `dc_` name
 * ```typescript
 * const collector = yield* GCP.Apigee.Datacollector("Latency", {
 *   type: "INTEGER",
 * });
 * ```
 *
 * **Example:** Explicit id and description
 * ```typescript
 * const collector = yield* GCP.Apigee.Datacollector("Latency", {
 *   dataCollectorId: "dc_proxy_latency",
 *   type: "INTEGER",
 *   description: "proxy latency in milliseconds",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Datacollector = Resource<Datacollector>(
  "GCP.Apigee.Datacollector",
);

export class DatacollectorNotResolved extends Data.TaggedError(
  "GCP.Apigee.DatacollectorNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_TYPE = "STRING";

const resourceName = (organization: string, dataCollectorId: string) =>
  `${orgNameOf(organization)}/datacollectors/${dataCollectorId}`;

const toAttrs = (
  collector: apigee.GoogleCloudApigeeV1DataCollector,
  organization: string,
) => {
  const name = collector.name ?? "";
  const parsed = parseDescription(collector.description);
  return {
    name,
    dataCollectorId: lastSegment(name),
    organization: orgIdOf(organization),
    description: parsed.description,
    type: collector.type,
    createdAt: collector.createdAt,
    lastModifiedAt: collector.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsDatacollectors({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const DatacollectorProvider = () =>
  Provider.succeed(Datacollector, {
    stables: ["name", "dataCollectorId", "organization", "type", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.dataCollectorId ?? output?.dataCollectorId;
      const previousOrg = olds?.organization ?? output?.organization;
      const previousType = olds?.type ?? output?.type ?? DEFAULT_TYPE;
      const nextType = news.type ?? DEFAULT_TYPE;
      const idChanged =
        previousId !== undefined &&
        news.dataCollectorId !== undefined &&
        news.dataCollectorId !== previousId;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization) !== orgIdOf(previousOrg);
      const typeChanged = previousType !== nextType;
      if (idChanged || orgChanged || typeChanged) {
        const sameName =
          !idChanged &&
          !orgChanged &&
          (news.dataCollectorId ?? previousId) === previousId;
        return { action: "replace" as const, deleteFirst: sameName };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(
        env.project,
        olds?.organization ?? output?.organization,
      );
      const dataCollectorId = yield* dcCollectorId(
        id,
        olds?.dataCollectorId,
        output?.dataCollectorId,
      );
      const name = output?.name ?? resourceName(organization, dataCollectorId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const orgs = yield* listOrgNames();
        const rows: Datacollector["Attributes"][] = [];
        for (const organization of orgs) {
          const collectors = yield* collectPages(
            apigee.listOrganizationsDatacollectors.pages({
              parent: organization,
              pageSize: 1000,
            }),
            (page) => page.dataCollectors,
          ).pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([] as apigee.GoogleCloudApigeeV1DataCollector[]),
            ),
          );
          for (const collector of collectors) {
            if (hasOwnershipMarker(collector.description)) {
              rows.push(toAttrs(collector, organization));
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(env.project, news.organization);
      const dataCollectorId = yield* dcCollectorId(
        id,
        news.dataCollectorId,
        output?.dataCollectorId,
      );
      const name = resourceName(organization, dataCollectorId);
      const type = news.type ?? DEFAULT_TYPE;
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsDatacollectors({
            parent: organization,
            dataCollectorId,
            body: {
              name: dataCollectorId,
              description: desiredDescription,
              type,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatacollectorNotResolved({ name });
      }

      if ((current.description ?? "") !== desiredDescription) {
        current = yield* apigee.patchOrganizationsDatacollectors({
          name,
          updateMask: "description",
          body: { description: desiredDescription },
        });
      }

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsDatacollectors({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
