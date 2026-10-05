import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
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
  DataplexNotResolved,
  collectPages,
  fingerprint,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type EntryTypeAspectInfo = {
  /** Required aspect type resource name for entries of this type. */
  type?: string;
};

export type EntryTypeAuthorization = {
  /**
   * IAM permission grantable on the Entry Group to instantiate Entries
   * of Dataplex-owned types. Immutable.
   */
  alternateUsePermission?: string;
};

export type EntryTypeProps = {
  /**
   * Entry type id (the `{entryType}` segment of
   * `projects/{project}/locations/{location}/entryTypes/{entryType}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable — changing it replaces the
   * entry type.
   */
  entryTypeId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the entry type. `US-CENTRAL1` is accepted and normalized
   * to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Classes this type belongs to (`TABLE`, `DATABASE`, `MODEL`, …).
   */
  typeAliases?: string[];
  /**
   * Platform that Entries of this type belong to.
   */
  platform?: string;
  /**
   * System that Entries of this type belong to (`CloudSQL`, `MariaDB`, …).
   */
  system?: string;
  /**
   * Aspect types required on Entries of this type.
   */
  requiredAspects?: EntryTypeAspectInfo[];
  /**
   * Authorization for this type. Immutable — changing it replaces the
   * entry type.
   */
  authorization?: EntryTypeAuthorization;
};

export type EntryType = Resource<
  "GCP.Dataplex.EntryType",
  EntryTypeProps,
  {
    /** Full resource name. */
    name: string;
    /** Entry type id (last path segment). */
    entryTypeId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Type aliases. */
    typeAliases: string[];
    /** Platform. */
    platform: string | undefined;
    /** System. */
    system: string | undefined;
    /** Required aspect types. */
    requiredAspects: EntryTypeAspectInfo[];
    /** Alternate use permission, if set. */
    alternateUsePermission: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** System-generated uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex Universal Catalog Entry Type — a template for creating
 * Entries.
 *
 * Changing `entryTypeId`, `location`, or `authorization` replaces the
 * type. Description, display name, labels, aliases, platform, system,
 * and required aspects update in place.
 *
 * ### Creating an Entry Type
 * **Example:** Generated name
 * ```typescript
 * const type = yield* GCP.Dataplex.EntryType("Table", {
 *   typeAliases: ["TABLE"],
 *   platform: "GCS",
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const type = yield* GCP.Dataplex.EntryType("Table", {
 *   entryTypeId: "app-table",
 *   displayName: "App table",
 *   system: "BigQuery",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Entry Type
 * **Example:** Description and aliases
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const type = yield* GCP.Dataplex.EntryType("Table", {
 *   entryTypeId: "app-table",
 *   description: "table v2",
 *   typeAliases: ["TABLE", "DATASET"],
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const EntryType = Resource<EntryType>("GCP.Dataplex.EntryType");

const resourceName = (project: string, location: string, entryTypeId: string) =>
  `projects/${project}/locations/${location}/entryTypes/${entryTypeId}`;

const toAttrs = (
  type: dataplex.GoogleCloudDataplexV1EntryType,
  project: string,
) => {
  const name = type.name ?? "";
  const parsed = parseName(name, "entryTypes");
  return {
    name,
    entryTypeId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: type.description,
    displayName: type.displayName,
    labels: userLabels(type.labels),
    typeAliases: type.typeAliases ?? [],
    platform: type.platform,
    system: type.system,
    requiredAspects: (type.requiredAspects ?? []).map((item) => ({
      type: item.type,
    })),
    alternateUsePermission: type.authorization?.alternateUsePermission,
    etag: type.etag,
    uid: type.uid,
    createTime: type.createTime,
    updateTime: type.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(dataplex.getProjectsLocationsEntryTypes({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listTypes = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      dataplex.listProjectsLocationsEntryTypes.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.entryTypes,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    );
  return listAtLocation(project, region, collect);
};

export const EntryTypeProvider = () =>
  Provider.succeed(EntryType, {
    stables: [
      "name",
      "entryTypeId",
      "project",
      "location",
      "alternateUsePermission",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousAuth =
        olds?.authorization?.alternateUsePermission ??
        output?.alternateUsePermission ??
        "";
      const nextAuth =
        news.authorization?.alternateUsePermission ?? previousAuth;
      return replaceOnIdentity({
        previousId: olds?.entryTypeId ?? output?.entryTypeId,
        nextId: news.entryTypeId ?? olds?.entryTypeId ?? output?.entryTypeId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: nextAuth !== previousAuth,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const entryTypeId = yield* toPhysicalId(
        id,
        olds?.entryTypeId,
        output?.entryTypeId,
        "entrytype",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, entryTypeId);
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
        const items = yield* listTypes(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const entryTypeId = yield* toPhysicalId(
        id,
        news.entryTypeId,
        output?.entryTypeId,
        "entrytype",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, entryTypeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAspects = news.requiredAspects;
      const desiredAliases = news.typeAliases;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsEntryTypes({
            parent: parentOf(env.project, location),
            entryTypeId,
            body: {
              description: news.description,
              displayName: news.displayName,
              labels: desiredLabels,
              typeAliases: desiredAliases,
              platform: news.platform,
              system: news.system,
              requiredAspects: desiredAspects,
              authorization: news.authorization,
            },
          })
          .pipe(
            retryQuota,
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new DataplexNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const aliasesChanged =
        desiredAliases !== undefined &&
        fingerprint(desiredAliases) !== fingerprint(current.typeAliases);
      const platformChanged =
        news.platform !== undefined &&
        (current.platform ?? "") !== news.platform;
      const systemChanged =
        news.system !== undefined && (current.system ?? "") !== news.system;
      const aspectsChanged =
        desiredAspects !== undefined &&
        fingerprint(desiredAspects) !== fingerprint(current.requiredAspects);

      if (
        labelsChanged ||
        descriptionChanged ||
        displayNameChanged ||
        aliasesChanged ||
        platformChanged ||
        systemChanged ||
        aspectsChanged
      ) {
        const operation = yield* retryQuota(
          dataplex.patchProjectsLocationsEntryTypes({
            name: current.name ?? name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              descriptionChanged ? "description" : undefined,
              displayNameChanged ? "displayName" : undefined,
              aliasesChanged ? "typeAliases" : undefined,
              platformChanged ? "platform" : undefined,
              systemChanged ? "system" : undefined,
              aspectsChanged ? "requiredAspects" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
              displayName: news.displayName,
              typeAliases: desiredAliases ?? current.typeAliases,
              platform: news.platform ?? current.platform,
              system: news.system ?? current.system,
              requiredAspects: desiredAspects ?? current.requiredAspects,
            },
          }),
        );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* dataplex
        .deleteProjectsLocationsEntryTypes({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" || error._tag === "TooManyRequests",
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
