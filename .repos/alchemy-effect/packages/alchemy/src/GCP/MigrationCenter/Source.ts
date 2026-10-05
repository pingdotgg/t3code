import * as mc from "@distilled.cloud/gcp/migrationcenter_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  expandParent,
  fieldMask,
  fingerprint,
  hasOwnershipMarker,
  lastSegment,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type SourceType = mc.SourceTypeEnum | (string & {});
export type SourceState = mc.SourceStateEnum | (string & {});

export type SourceProps = {
  /**
   * Source id (the `{source}` segment of
   * `projects/{project}/locations/{location}/sources/{source}`). If
   * omitted, a unique RFC1035 name is generated. Immutable — changing it
   * replaces the source.
   */
  sourceId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * source. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Data source type. Immutable — changing it replaces the source.
   * @default "SOURCE_TYPE_UPLOAD"
   */
  type?: SourceType;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * Free-text description. Sources have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  description?: string;
  /**
   * Information confidence of the source. Higher is more confident.
   */
  priority?: number;
};

export type Source = Resource<
  "GCP.MigrationCenter.Source",
  SourceProps,
  {
    /** Full resource name. */
    name: string;
    /** Source id (last path segment). */
    sourceId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Data source type. */
    type: string | undefined;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Information confidence. */
    priority: number | undefined;
    /** Whether another service manages this source. */
    managed: boolean | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Frames still being processed. */
    pendingFrameCount: number | undefined;
    /** Frames that contained errors. */
    errorFrameCount: number | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Migration Center source that streams asset frames into a project.
 *
 * Sources have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. `sourceId`, `location`, and
 * `type` are immutable. Display name, description, and priority update
 * in place.
 *
 * ### Creating a Source
 * **Example:** Upload source
 * ```typescript
 * const source = yield* GCP.MigrationCenter.Source("Inventory", {
 *   type: "SOURCE_TYPE_UPLOAD",
 *   displayName: "rvtools",
 * });
 * ```
 *
 * **Example:** Discovery-client source
 * ```typescript
 * const source = yield* GCP.MigrationCenter.Source("Scanner", {
 *   type: "SOURCE_TYPE_DISCOVERY_CLIENT",
 *   description: "on-prem scanner",
 * });
 * ```
 *
 * @resource
 * @category MigrationCenter
 */
export const Source = Resource<Source>("GCP.MigrationCenter.Source");

const DEFAULT_TYPE: SourceType = "SOURCE_TYPE_UPLOAD";

const resourceName = (project: string, location: string, sourceId: string) =>
  `${locationParent(project, location)}/sources/${sourceId}`;

const toAttrs = (source: mc.Source, project: string, region: string) => {
  const name = source.name ?? "";
  const parsed = parseName(name, "sources", region);
  const ownership = parseOwnership(source.description);
  return {
    name,
    sourceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    type: source.type,
    displayName: source.displayName,
    description: ownership.text,
    priority: source.priority,
    managed: source.managed,
    state: source.state,
    pendingFrameCount: source.pendingFrameCount,
    errorFrameCount: source.errorFrameCount,
    createTime: source.createTime,
    updateTime: source.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : mc
        .getProjectsLocationsSources({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  mc.listProjectsLocationsSources
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sources ?? [])),
      Stream.filter((item) => hasOwnershipMarker(item.description)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        mc.listProjectsLocationsSources
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.sources ?? [])),
            Stream.filter((item) => hasOwnershipMarker(item.description)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as mc.Source[]),
            ),
          ),
      ),
    );

export const SourceProvider = () =>
  Provider.succeed(Source, {
    stables: ["name", "sourceId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = olds?.type ?? output?.type ?? DEFAULT_TYPE;
      const nextType = news.type ?? previousType;
      return replaceOnIdentity({
        previousId: olds?.sourceId ?? output?.sourceId,
        nextId: news.sourceId ?? olds?.sourceId ?? output?.sourceId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: previousType !== nextType,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sourceId = yield* toPhysicalId(
        id,
        olds?.sourceId,
        output?.sourceId,
        "source",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, sourceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
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
      const sourceId = yield* toPhysicalId(
        id,
        news.sourceId,
        output?.sourceId,
        "source",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, sourceId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const type = news.type ?? DEFAULT_TYPE;
      const displayName = news.displayName ?? sourceId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* mc
          .createProjectsLocationsSources({
            parent: locationParent(env.project, location),
            sourceId,
            body: {
              type,
              displayName,
              description,
              priority: news.priority,
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

      const descriptionChanged = (current.description ?? "") !== description;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const priorityChanged =
        fingerprint(current.priority) !== fingerprint(news.priority);
      const mask = fieldMask([
        descriptionChanged && "description",
        displayNameChanged && "displayName",
        priorityChanged && "priority",
      ]);

      if (mask.length > 0) {
        const operation = yield* mc.patchProjectsLocationsSources({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            displayName,
            description,
            priority: news.priority,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* mc
        .deleteProjectsLocationsSources({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 10,
            schedule: Schedule.spaced("3 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });

export const sourceNameOf = (
  value: string,
  project: string,
  location: string,
) => expandParent(value, project, location, "sources");

export const sourceIdOf = (name: string) => lastSegment(name);
