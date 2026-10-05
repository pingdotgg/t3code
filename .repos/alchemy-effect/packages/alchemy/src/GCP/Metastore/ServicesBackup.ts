import * as metastore from "@distilled.cloud/gcp/metastore_v1";
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
  encodeOwnership,
  expandParent,
  hasOwnershipMarker,
  listAtNested,
  listOwnedPages,
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
  waitUntilReady,
} from "./internal.ts";

export type ServicesBackupProps = {
  /**
   * Parent Dataproc Metastore service. Full name
   * `projects/{project}/locations/{location}/services/{service}` or the
   * service id (combined with `location`). Immutable — changing it
   * replaces the backup.
   */
  service: string;
  /**
   * Region used when `service` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Backup id (the `{backup}` segment). If omitted, a unique RFC1035 name
   * is generated. Must begin with a letter and end with a letter or
   * number. Immutable — changing it replaces the backup.
   */
  backupId?: string;
  /**
   * Human-readable description. Backups have no labels field and no
   * update API, so Alchemy stamps ownership into the description at
   * create and cannot change it in place.
   */
  description?: string;
};

export type ServicesBackup = Resource<
  "GCP.Metastore.ServicesBackup",
  ServicesBackupProps,
  {
    /** Full resource name. */
    name: string;
    /** Backup id (last path segment). */
    backupId: string;
    /** Parent service name. */
    service: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Services currently restoring from this backup. */
    restoringServices: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 completion timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataproc Metastore service backup — a point-in-time capture of a
 * Hive metastore.
 *
 * Changing `backupId`, `service`, or `location` replaces the backup.
 * Description is set at create; backups have no update API.
 *
 * ### Creating a Backup
 * **Example:** Manual backup
 * ```typescript
 * const backup = yield* GCP.Metastore.ServicesBackup("Nightly", {
 *   service: hive.name,
 *   description: "pre-release",
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const backup = yield* GCP.Metastore.ServicesBackup("Nightly", {
 *   service: hive.name,
 *   backupId: "nightly-01",
 * });
 * ```
 *
 * @resource
 * @category Metastore
 */
export const ServicesBackup = Resource<ServicesBackup>(
  "GCP.Metastore.ServicesBackup",
);

const resourceName = (service: string, backupId: string) =>
  `${service}/backups/${backupId}`;

const toAttrs = (item: metastore.Backup, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "backups", region);
  const { text } = parseOwnership(item.description);
  return {
    name,
    backupId: parsed.id,
    service: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    description: text,
    state: item.state,
    restoringServices: item.restoringServices ?? [],
    createTime: item.createTime,
    endTime: item.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : metastore
        .getProjectsLocationsServicesBackups({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtNested(project, "services/-", (parent) =>
    listOwnedPages(
      metastore.listProjectsLocationsServicesBackups.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.backups,
      (item) => hasOwnershipMarker(item.description),
    ),
  );

export const ServicesBackupProvider = () =>
  Provider.succeed(ServicesBackup, {
    stables: [
      "name",
      "backupId",
      "service",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.backupId ?? output?.backupId,
        nextId: news.backupId ?? olds?.backupId ?? output?.backupId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.service ?? output?.service,
        nextParent: news.service,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupId = yield* toPhysicalId(
        id,
        olds?.backupId,
        output?.backupId,
        "backup",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const service = expandParent(
        olds?.service ?? output?.service ?? "",
        env.project,
        location,
        "services",
      );
      const name = output?.name ?? resourceName(service, backupId);
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
      const backupId = yield* toPhysicalId(
        id,
        news.backupId,
        output?.backupId,
        "backup",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const service = expandParent(
        news.service,
        env.project,
        location,
        "services",
      );
      const name = resourceName(service, backupId);
      const desiredLabels = yield* createInternalLabels(id);
      const description = encodeOwnership(desiredLabels, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* metastore
          .createProjectsLocationsServicesBackups({
            parent: service,
            backupId,
            body: { description },
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
        current = yield* waitUntilReady(
          getByName(name),
          name,
          (item) => item.state,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* metastore
        .deleteProjectsLocationsServicesBackups({ name: output.name })
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
