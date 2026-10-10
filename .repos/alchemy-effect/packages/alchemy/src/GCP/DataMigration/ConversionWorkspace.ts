import * as dm from "@distilled.cloud/gcp/datamigration_v1";
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
  encodeOwnershipLine,
  fieldMask,
  fingerprint,
  hasOwnershipMarker,
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

export type DatabaseEngineInfo = dm.DatabaseEngineInfo;
export type ConversionWorkspaceSourceProvider =
  | dm.ConversionWorkspaceSourceProviderEnum
  | (string & {});
export type ConversionWorkspaceDestinationProvider =
  | dm.ConversionWorkspaceDestinationProviderEnum
  | (string & {});

export type ConversionWorkspaceProps = {
  /**
   * Conversion workspace id (the `{conversionWorkspace}` segment of
   * `projects/{project}/locations/{location}/conversionWorkspaces/{conversionWorkspace}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the workspace.
   */
  conversionWorkspaceId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * workspace. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name. Maximum length is 63 characters including
   * Alchemy's ownership marker. Conversion workspaces have no labels
   * field, so ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  displayName?: string;
  /**
   * Source engine and version. Immutable — changing it replaces the
   * workspace.
   */
  source: DatabaseEngineInfo;
  /**
   * Destination engine and version. Immutable — changing it replaces the
   * workspace.
   */
  destination: DatabaseEngineInfo;
  /**
   * Provider for the source database (`CLOUDSQL`, `RDS`, `AURORA`,
   * `ALLOYDB`, `AZURE_DATABASE`). Immutable — changing it replaces the
   * workspace.
   */
  sourceProvider?: ConversionWorkspaceSourceProvider;
  /**
   * Provider for the destination database. Immutable — changing it
   * replaces the workspace.
   */
  destinationProvider?: ConversionWorkspaceDestinationProvider;
  /**
   * Database-pair specific workspace settings
   * (`convert_foreign_key_to_interleave`, `skip_triggers`, …).
   */
  globalSettings?: Record<string, string>;
};

export type ConversionWorkspace = Resource<
  "GCP.DataMigration.ConversionWorkspace",
  ConversionWorkspaceProps,
  {
    /** Full resource name. */
    name: string;
    /** Conversion workspace id (last path segment). */
    conversionWorkspaceId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Source engine details. */
    source: DatabaseEngineInfo | undefined;
    /** Destination engine details. */
    destination: DatabaseEngineInfo | undefined;
    /** Source database provider. */
    sourceProvider: string | undefined;
    /** Destination database provider. */
    destinationProvider: string | undefined;
    /** Workspace-level mapping-engine settings. */
    globalSettings: Record<string, string>;
    /** Whether the workspace has uncommitted changes. */
    hasUncommittedChanges: boolean | undefined;
    /** Latest commit id. */
    latestCommitId: string | undefined;
    /** RFC3339 latest commit timestamp. */
    latestCommitTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Database Migration Service conversion workspace: source and
 * destination engines plus optional mapping-engine settings used by
 * heterogeneous migrations.
 *
 * Conversion workspaces have no labels field — Alchemy stamps ownership
 * into the display name so `list` / nuke can find them. `source`,
 * `destination`, and their providers are replacement triggers. Display
 * name and `globalSettings` update in place.
 *
 * ### Creating a Conversion Workspace
 * **Example:** MySQL to PostgreSQL
 * ```typescript
 * const workspace = yield* GCP.DataMigration.ConversionWorkspace("MysqlToPg", {
 *   displayName: "mysql-to-pg",
 *   source: { engine: "MYSQL", version: "8.0" },
 *   destination: { engine: "POSTGRESQL", version: "14" },
 * });
 * ```
 *
 * **Example:** Oracle to PostgreSQL with settings
 * ```typescript
 * const workspace = yield* GCP.DataMigration.ConversionWorkspace("OraToPg", {
 *   source: { engine: "ORACLE", version: "19" },
 *   destination: { engine: "POSTGRESQL", version: "15" },
 *   globalSettings: { skip_triggers: "true" },
 * });
 * ```
 *
 * @resource
 * @category DataMigration
 */
export const ConversionWorkspace = Resource<ConversionWorkspace>(
  "GCP.DataMigration.ConversionWorkspace",
);

const resourceName = (
  project: string,
  location: string,
  conversionWorkspaceId: string,
) =>
  `${locationParent(project, location)}/conversionWorkspaces/${conversionWorkspaceId}`;

const settingsOf = (
  value: Record<string, string | undefined> | null | undefined,
): Record<string, string> => {
  const next: Record<string, string> = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (item !== undefined) next[key] = item;
  }
  return next;
};

const toAttrs = (workspace: dm.ConversionWorkspace, project: string) => {
  const name = workspace.name ?? "";
  const parsed = parseName(name, "conversionWorkspaces");
  const ownership = parseOwnership(workspace.displayName);
  return {
    name,
    conversionWorkspaceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: ownership.text,
    source: workspace.source,
    destination: workspace.destination,
    sourceProvider: workspace.sourceProvider,
    destinationProvider: workspace.destinationProvider,
    globalSettings: settingsOf(workspace.globalSettings),
    hasUncommittedChanges: workspace.hasUncommittedChanges,
    latestCommitId: workspace.latestCommitId,
    latestCommitTime: workspace.latestCommitTime,
    createTime: workspace.createTime,
    updateTime: workspace.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dm
        .getProjectsLocationsConversionWorkspaces({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  dm.listProjectsLocationsConversionWorkspaces
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.conversionWorkspaces ?? []),
      ),
      Stream.filter((item) => hasOwnershipMarker(item.displayName)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        dm.listProjectsLocationsConversionWorkspaces
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.conversionWorkspaces ?? []),
            ),
            Stream.filter((item) => hasOwnershipMarker(item.displayName)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as dm.ConversionWorkspace[]),
            ),
          ),
      ),
    );

const engineOf = (value: DatabaseEngineInfo | undefined) =>
  fingerprint({
    engine: value?.engine,
    version: value?.version,
  });

export const ConversionWorkspaceProvider = () =>
  Provider.succeed(ConversionWorkspace, {
    stables: [
      "name",
      "conversionWorkspaceId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId:
          olds?.conversionWorkspaceId ?? output?.conversionWorkspaceId,
        nextId:
          news.conversionWorkspaceId ??
          olds?.conversionWorkspaceId ??
          output?.conversionWorkspaceId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          engineOf(news.source) !== engineOf(olds?.source ?? output?.source) ||
          engineOf(news.destination) !==
            engineOf(olds?.destination ?? output?.destination) ||
          (news.sourceProvider ??
            olds?.sourceProvider ??
            output?.sourceProvider) !==
            (olds?.sourceProvider ?? output?.sourceProvider) ||
          (news.destinationProvider ??
            olds?.destinationProvider ??
            output?.destinationProvider) !==
            (olds?.destinationProvider ?? output?.destinationProvider),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const conversionWorkspaceId = yield* toPhysicalId(
        id,
        olds?.conversionWorkspaceId,
        output?.conversionWorkspaceId,
        "workspace",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, conversionWorkspaceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
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
      const conversionWorkspaceId = yield* toPhysicalId(
        id,
        news.conversionWorkspaceId,
        output?.conversionWorkspaceId,
        "workspace",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, conversionWorkspaceId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const globalSettings = news.globalSettings;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dm
          .createProjectsLocationsConversionWorkspaces({
            parent: locationParent(env.project, location),
            conversionWorkspaceId,
            body: {
              displayName,
              source: news.source,
              destination: news.destination,
              sourceProvider: news.sourceProvider,
              destinationProvider: news.destinationProvider,
              globalSettings,
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

      const observedDisplay = current.displayName ?? "";
      const displayNameChanged = observedDisplay !== displayName;
      const settingsChanged =
        fingerprint(settingsOf(current.globalSettings)) !==
        fingerprint(globalSettings);
      const mask = fieldMask([
        displayNameChanged && "displayName",
        settingsChanged && "globalSettings",
      ]);

      if (mask.length > 0) {
        const operation = yield* dm.patchProjectsLocationsConversionWorkspaces({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            displayName,
            globalSettings,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* dm
        .deleteProjectsLocationsConversionWorkspaces({
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
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
