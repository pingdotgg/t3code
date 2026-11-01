import * as apim from "@distilled.cloud/gcp/apim_v1alpha";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type GclbObservationSource,
  ResourceNotResolved,
  expandGclb,
  hasAlchemyId,
  listAtLocation,
  collectPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameJson,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type { GclbObservationSource, PscNetworkConfig } from "./internal.ts";

const COLLECTION = "observationSources";
const READY = new Set(["CREATED"]);

export type ObservationSourceProps = {
  /**
   * Observation source id (the `{source}` segment of
   * `projects/{project}/locations/{location}/observationSources/{source}`).
   * Must be 4-63 lowercase letters, digits, or hyphens. If omitted, a
   * unique `alch-` prefixed name is generated. Immutable — changing it
   * replaces the source.
   */
  observationSourceId?: string;
  /**
   * Region of the source (`us-central1`, …). Immutable — changing it
   * replaces the source. The API currently allows one source per region.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * GCLB observation source. Required. `pscNetworkConfigs` names the
   * VPC and subnet used to attach PSC NEGs to Cloud Load Balancers.
   * Immutable — changing it replaces the source.
   */
  gclbObservationSource: GclbObservationSource;
};

export type ObservationSource = Resource<
  "GCP.Apim.ObservationSource",
  ObservationSourceProps,
  {
    /** Full resource name. */
    name: string;
    /** Observation source id (last path segment). */
    observationSourceId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** GCLB observation source configuration. */
    gclbObservationSource: GclbObservationSource | undefined;
    /** Server-reported state. */
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
 * An API Observation source — configuration for collecting traffic from
 * Cloud Load Balancers in a VPC. Sources have no labels, description,
 * or update API; Alchemy stamps ownership into generated ids (`alch-`)
 * so `list` / nuke can find them. Identity, location, and GCLB network
 * config replace the resource.
 *
 * ### Creating an Observation Source
 * **Example:** Observe a VPC via PSC
 * ```typescript
 * const source = yield* GCP.Apim.ObservationSource("Edge", {
 *   gclbObservationSource: {
 *     pscNetworkConfigs: [
 *       {
 *         network: network.selfLink,
 *         subnetwork: subnet.selfLink,
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 * @category Apim
 */
export const ObservationSource = Resource<ObservationSource>(
  "GCP.Apim.ObservationSource",
);

const toGclb = (
  source: apim.GclbObservationSource | undefined,
): GclbObservationSource | undefined => {
  const configs = source?.pscNetworkConfigs ?? [];
  if (configs.length === 0) return undefined;
  return {
    pscNetworkConfigs: configs.flatMap((config) =>
      config.network && config.subnetwork
        ? [
            {
              network: config.network,
              subnetwork: config.subnetwork,
            },
          ]
        : [],
    ),
  };
};

const toAttrs = (
  location: string,
  item: apim.ObservationSource,
  project: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    observationSourceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || location,
    gclbObservationSource: toGclb(item.gclbObservationSource),
    state: item.state,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apim
        .getProjectsLocationsObservationSources({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    collectPages(
      apim.listProjectsLocationsObservationSources.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.observationSources,
    ),
  ).pipe(
    Effect.map((items) =>
      items.filter((item) =>
        hasAlchemyId(parseName(item.name ?? "", COLLECTION).id),
      ),
    ),
  );

export const ObservationSourceProvider = () =>
  Provider.succeed(ObservationSource, {
    stables: [
      "name",
      "observationSourceId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location ?? env.region,
      );
      const previous = expandGclb(
        olds?.gclbObservationSource ?? output?.gclbObservationSource,
        env.project,
        location,
      );
      const desired = expandGclb(
        news.gclbObservationSource,
        env.project,
        location,
      );
      return replaceOnIdentity({
        previousId: olds?.observationSourceId ?? output?.observationSourceId,
        nextId:
          news.observationSourceId ??
          olds?.observationSourceId ??
          output?.observationSourceId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: location,
        extra: previous !== undefined && !sameJson(previous, desired),
        // MVP: one source per region, so replace must delete first.
        deleteFirst: true,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const observationSourceId = yield* toPhysicalId(
        id,
        olds?.observationSourceId,
        output?.observationSourceId,
        "src",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, observationSourceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(location, existing, env.project);
      // No labels/description. Generated `alch-` ids are owned; an
      // explicit id that already exists is Unowned unless we persisted it.
      if (output !== undefined || hasAlchemyId(attrs.observationSourceId)) {
        return attrs;
      }
      return Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(env.region, item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const observationSourceId = yield* toPhysicalId(
        id,
        news.observationSourceId,
        output?.observationSourceId,
        "src",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        observationSourceId,
      );
      const gclbObservationSource = expandGclb(
        news.gclbObservationSource,
        env.project,
        location,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apim
          .createProjectsLocationsObservationSources({
            parent: parentOf(env.project, location),
            observationSourceId,
            body: {
              gclbObservationSource,
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

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
        READY,
      );

      return toAttrs(location, current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apim
        .deleteProjectsLocationsObservationSources({ name: output.name })
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
