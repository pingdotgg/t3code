import * as datalineage from "@distilled.cloud/gcp/datalineage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createOwnership,
  desiredAttributes,
  findOwnedProcess,
  listOwnedProcesses,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
  userAttributes,
  waitForOperation,
  waitUntilGone,
} from "./internal.ts";

export type ProcessOrigin = {
  /**
   * Origin system. Use `CUSTOM` unless reporting lineage on behalf of a
   * Google system. Non-`CUSTOM` sources may be restricted and billed.
   * @default "CUSTOM"
   */
  sourceType?:
    | datalineage.GoogleCloudDatacatalogLineageV1OriginSourceTypeEnum
    | (string & {});
  /**
   * Origin name. For `CUSTOM`, any identifier. For Google systems, a
   * resource name in the same project and location.
   */
  name?: string;
};

export type ProcessProps = {
  /**
   * Process id (the `{process}` segment of
   * `projects/{project}/locations/{location}/processes/{process}`). If
   * omitted, a unique name is generated from the stack, stage, and logical
   * id. Max 200 characters: letters, digits, underscores, hyphens, colons,
   * periods. Immutable — changing it replaces the process.
   */
  processId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * process. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Human-readable name shown in UIs. Max 200 characters.
   */
  displayName?: string;
  /**
   * Origin of this process and its runs. Defaults to `{ sourceType:
   * "CUSTOM", name: "alchemy" }`.
   */
  origin?: ProcessOrigin;
  /**
   * Non-semantic attributes (classifying or labeling the process). Max
   * 100 entries. Processes have no labels field, so Alchemy stamps
   * `alchemy-stack` / `alchemy-stage` / `alchemy-id` here for `list` /
   * nuke and strips them from attributes.
   */
  attributes?: Record<string, unknown>;
};

export type Process = Resource<
  "GCP.DataLineage.Process",
  ProcessProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/processes/{process}`. */
    name: string;
    /** Process id (last path segment). */
    processId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** Origin of the process. */
    origin: ProcessOrigin | undefined;
    /** User attributes (Alchemy ownership keys stripped). */
    attributes: Record<string, unknown>;
  },
  never,
  Providers
>;

/**
 * A Data Lineage process — the definition of a data transformation.
 *
 * Processes have no labels field, so Alchemy stamps ownership into
 * `attributes` for `list` / nuke. `processId` and `location` are identity
 * — changing either replaces the process. Display name, origin, and
 * attributes update in place.
 *
 * ### Creating a Process
 * **Example:** Generated name
 * ```typescript
 * const process = yield* GCP.DataLineage.Process("Etl", {
 *   displayName: "nightly etl",
 *   attributes: { env: "dev" },
 * });
 * ```
 *
 * **Example:** Named process with a custom origin
 * ```typescript
 * const process = yield* GCP.DataLineage.Process("Etl", {
 *   processId: "orders-etl",
 *   location: "us-central1",
 *   displayName: "orders etl",
 *   origin: { sourceType: "CUSTOM", name: "dbt" },
 *   attributes: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category DataLineage
 */
export const Process = Resource<Process>("GCP.DataLineage.Process");

export class ProcessNotResolved extends Data.TaggedError(
  "GCP.DataLineage.ProcessNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, processId: string) =>
  `${locationParent(project, location)}/processes/${processId}`;

const defaultOrigin = (
  origin: ProcessOrigin | undefined,
): datalineage.GoogleCloudDatacatalogLineageV1Origin => ({
  sourceType: origin?.sourceType ?? "CUSTOM",
  name: origin?.name ?? "alchemy",
});

const toAttrs = (
  process: datalineage.GoogleCloudDatacatalogLineageV1Process,
  project: string,
  region: string,
) => {
  const name = process.name ?? "";
  const parsed = parseName(name, "processes", region);
  return {
    name,
    processId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: process.displayName,
    origin: process.origin
      ? {
          sourceType: process.origin.sourceType,
          name: process.origin.name,
        }
      : undefined,
    attributes: userAttributes(process.attributes),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datalineage
        .getProjectsLocationsProcesses({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ProcessProvider = () =>
  Provider.succeed(Process, {
    stables: ["name", "processId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      return replaceOnIdentity({
        previousId: olds?.processId ?? output?.processId,
        nextId: news.processId,
        extra: output !== undefined && previousLocation !== nextLocation,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const processId = yield* toPhysicalId(
        id,
        olds?.processId,
        output?.processId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, processId);
      const existing =
        (yield* getByName(name)) ??
        (yield* findOwnedProcess(id, env.project, location));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.attributes))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listOwnedProcesses(env.project, env.region);
        return rows.map((row) => toAttrs(row, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const processId = yield* toPhysicalId(
        id,
        news.processId,
        output?.processId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, processId);
      const ownership = yield* createOwnership(id);
      const attributes = desiredAttributes(news.attributes, ownership);

      let current =
        (yield* getByName(name)) ??
        (yield* findOwnedProcess(id, env.project, location));

      if (current === undefined) {
        const created = yield* datalineage
          .createProjectsLocationsProcesses({
            parent: locationParent(env.project, location),
            body: {
              name,
              displayName: news.displayName,
              origin: defaultOrigin(news.origin),
              attributes,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(name).pipe(
                Effect.flatMap((row) =>
                  row
                    ? Effect.succeed(row)
                    : findOwnedProcess(id, env.project, location),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ProcessNotResolved({ name });
      }

      const resolvedName = current.name ?? name;
      const desiredOrigin = defaultOrigin(news.origin ?? current.origin);
      const displayName = news.displayName ?? current.displayName;
      const originChanged = !sameJson(current.origin, desiredOrigin);
      const displayNameChanged = !sameText(current.displayName, displayName);
      const attributesChanged = !sameJson(current.attributes, attributes);

      if (originChanged || displayNameChanged || attributesChanged) {
        current = yield* datalineage.patchProjectsLocationsProcesses({
          name: resolvedName,
          body: {
            name: resolvedName,
            displayName,
            origin: desiredOrigin,
            attributes,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* datalineage
        .deleteProjectsLocationsProcesses({
          name: output.name,
          allowMissing: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
