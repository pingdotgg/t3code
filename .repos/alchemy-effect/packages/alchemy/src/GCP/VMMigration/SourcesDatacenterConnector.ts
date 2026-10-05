import * as vm from "@distilled.cloud/gcp/vmmigration_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnershipLine,
  forEachSource,
  hasOwnershipMarker,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  sourceOf,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type DatacenterConnectorState =
  | vm.DatacenterConnectorStateEnum
  | (string & {});

export type SourcesDatacenterConnectorProps = {
  /**
   * Parent source. Full name
   * `projects/{project}/locations/{location}/sources/{source}` or the
   * source id (combined with `location`). Immutable — changing it
   * replaces the connector.
   */
  source: string;
  /**
   * Region used when `source` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Datacenter connector id. If omitted, a unique RFC1035 name is
   * generated. Immutable — changing it replaces the connector.
   */
  datacenterConnectorId?: string;
  /**
   * Unique registration key supplied by the OVA connector. Immutable —
   * changing it replaces the connector. Defaults to the connector id.
   */
  registrationId?: string;
  /**
   * Appliance version. Connectors have no labels or description field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  version?: string;
  /**
   * Service account the connector uses when talking to Google Cloud.
   */
  serviceAccount?: string;
};

export type SourcesDatacenterConnector = Resource<
  "GCP.VMMigration.SourcesDatacenterConnector",
  SourcesDatacenterConnectorProps,
  {
    /** Full resource name. */
    name: string;
    /** Datacenter connector id (last path segment). */
    datacenterConnectorId: string;
    /** Parent source resource name. */
    source: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Registration key. */
    registrationId: string | undefined;
    /** Appliance version with the Alchemy ownership prefix stripped. */
    version: string | undefined;
    /** Service account used by the connector. */
    serviceAccount: string | undefined;
    /** Communication bucket. */
    bucket: string | undefined;
    /** Health state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VM Migration datacenter connector registered against a VMware
 * source. The on-prem OVA appliance uses the registration id to bind to
 * this resource.
 *
 * Connectors have no labels or description — Alchemy stamps ownership
 * into `version` so `list` / nuke can find them. The API has no patch
 * method; changing identity or registration replaces the connector.
 *
 * ### Creating a Datacenter Connector
 * **Example:** Register against a source
 * ```typescript
 * const source = yield* GCP.VMMigration.Source("Vcenter", {
 *   vmware: { vcenterIp: "10.0.0.4", username: "admin" },
 * });
 * const connector = yield* GCP.VMMigration.SourcesDatacenterConnector(
 *   "Appliance",
 *   {
 *     source: source.name,
 *     version: "1.0.0",
 *   },
 * );
 * ```
 *
 * @resource
 * @category VMMigration
 */
export const SourcesDatacenterConnector = Resource<SourcesDatacenterConnector>(
  "GCP.VMMigration.SourcesDatacenterConnector",
);

const resourceName = (source: string, datacenterConnectorId: string) =>
  `${source}/datacenterConnectors/${datacenterConnectorId}`;

const toAttrs = (
  connector: vm.DatacenterConnector,
  project: string,
  region: string,
) => {
  const name = connector.name ?? "";
  const parsed = parseName(name, "datacenterConnectors", region);
  const ownership = parseOwnership(connector.version);
  return {
    name,
    datacenterConnectorId: parsed.id,
    source: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    registrationId: connector.registrationId,
    version: ownership.text,
    serviceAccount: connector.serviceAccount,
    bucket: connector.bucket,
    state: connector.state,
    createTime: connector.createTime,
    updateTime: connector.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vm
        .getProjectsLocationsSourcesDatacenterConnectors({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listChildren = (parent: string) =>
  collectPages(
    vm.listProjectsLocationsSourcesDatacenterConnectors.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.datacenterConnectors,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as vm.DatacenterConnector[]),
    ),
  );

export const SourcesDatacenterConnectorProvider = () =>
  Provider.succeed(SourcesDatacenterConnector, {
    stables: [
      "name",
      "datacenterConnectorId",
      "source",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousSource = olds?.source ?? output?.source;
      const extra =
        (news.registrationId !== undefined &&
          (olds?.registrationId ?? output?.registrationId) !== undefined &&
          news.registrationId !==
            (olds?.registrationId ?? output?.registrationId)) ||
        (news.serviceAccount !== undefined &&
          (olds?.serviceAccount ?? output?.serviceAccount) !== undefined &&
          news.serviceAccount !==
            (olds?.serviceAccount ?? output?.serviceAccount));
      return replaceOnIdentity({
        previousId:
          olds?.datacenterConnectorId ?? output?.datacenterConnectorId,
        nextId:
          news.datacenterConnectorId ??
          olds?.datacenterConnectorId ??
          output?.datacenterConnectorId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: previousSource,
        nextParent: news.source ?? previousSource,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const datacenterConnectorId = yield* toPhysicalId(
        id,
        olds?.datacenterConnectorId,
        output?.datacenterConnectorId,
        "connector",
      );
      const source =
        olds?.source !== undefined
          ? sourceOf(olds.source, env.project, location)
          : (output?.source ?? "");
      const name =
        output?.name ??
        (source.length > 0 ? resourceName(source, datacenterConnectorId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.version))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* forEachSource(
          env.project,
          listChildren,
          env.region,
        );
        return items
          .filter((item) => hasOwnershipMarker(item.version))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const source = sourceOf(news.source, env.project, location);
      const datacenterConnectorId = yield* toPhysicalId(
        id,
        news.datacenterConnectorId,
        output?.datacenterConnectorId,
        "connector",
      );
      const name = resourceName(source, datacenterConnectorId);
      const ownership = yield* createInternalLabels(id);
      const version = encodeOwnershipLine(ownership, news.version, 128);
      const registrationId = news.registrationId ?? datacenterConnectorId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vm
          .createProjectsLocationsSourcesDatacenterConnectors({
            parent: source,
            datacenterConnectorId,
            body: {
              registrationId,
              version,
              serviceAccount: news.serviceAccount,
            },
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

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vm
        .deleteProjectsLocationsSourcesDatacenterConnectors({
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
