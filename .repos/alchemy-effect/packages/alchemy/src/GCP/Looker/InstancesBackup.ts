import * as looker from "@distilled.cloud/gcp/looker_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";

const MAX_NAME_LENGTH = 63;
const OWNERSHIP_PREFIX = "alch-";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EncryptionConfig = {
  /** CMEK key resource name. */
  kmsKeyName?: string;
  /** Full CMEK key version currently in use. */
  kmsKeyNameVersion?: string;
  /** CMEK key status (`VALID`, `REVOKED`, …). */
  kmsKeyState?: string;
};

export type InstancesBackupProps = {
  /**
   * Parent Looker instance. Full name
   * `projects/{project}/locations/{location}/instances/{instance}` or
   * the instance id (combined with `location`). Immutable — changing it
   * replaces the backup.
   */
  instance: string;
  /**
   * Region of the parent instance when `instance` is a bare id.
   * Ignored when `instance` is a full resource name. Immutable —
   * changing it replaces the backup. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Backup id (the `{backup}` segment of
   * `.../instances/{instance}/backups/{backup}`). If omitted, a unique
   * RFC1035 name is generated with an `alch-` prefix so `list` / nuke
   * can find it. The backups API has no labels or description field;
   * ownership is stamped in the backup id. Immutable — changing it
   * replaces the backup. The API may ignore a requested id and assign
   * a UUID; Alchemy then tracks the server-assigned name.
   */
  backupId?: string;
};

export type InstancesBackup = Resource<
  "GCP.Looker.InstancesBackup",
  InstancesBackupProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/instances/{instance}/backups/{backup}`. */
    name: string;
    /** Backup id (last path segment). */
    backupId: string;
    /** Parent instance resource name. */
    instance: string;
    /** Parent instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** Server-reported state (`ACTIVE`, `CREATING`, `FAILED`, …). */
    state: string | undefined;
    /** Customer-managed encryption status, if any. */
    encryptionConfig: EncryptionConfig | undefined;
    /** RFC3339 time when the backup was started. */
    createTime: string | undefined;
    /** RFC3339 time when the backup will be deleted. */
    expireTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Looker (Google Cloud core) instance backup.
 *
 * Backups are existence-only: the API exposes no mutable fields. Changing
 * `instance`, `location`, or `backupId` replaces the backup. Looker
 * instance backups have no labels or description, so Alchemy stamps
 * ownership into a generated `alch-` backup id for `list` / nuke.
 *
 * Create and delete are long-running operations. Provisioning a parent
 * Looker instance is slow and billed; live lifecycle tests skipIf-gate
 * behind `FAST` and the typed Looker API entitlement error.
 *
 * ### Creating a Backup
 * **Example:** Generated id
 * ```typescript
 * const backup = yield* GCP.Looker.InstancesBackup("Nightly", {
 *   instance: instance.name,
 * });
 * ```
 *
 * **Example:** Explicit id and parent
 * ```typescript
 * const backup = yield* GCP.Looker.InstancesBackup("Nightly", {
 *   instance: "projects/my-project/locations/us-central1/instances/analytics",
 *   backupId: "alch-nightly",
 * });
 * ```
 *
 * @resource
 * @category Looker
 */
export const InstancesBackup = Resource<InstancesBackup>(
  "GCP.Looker.InstancesBackup",
);

export class InstancesBackupNotResolved extends Data.TaggedError(
  "GCP.Looker.InstancesBackupNotResolved",
)<{
  name: string;
}> {}

export class InstancesBackupInstanceMissing extends Data.TaggedError(
  "GCP.Looker.InstancesBackupInstanceMissing",
)<{
  message: string;
}> {}

export class InstancesBackupNotReady extends Data.TaggedError(
  "GCP.Looker.InstancesBackupNotReady",
)<{
  name: string;
  state: string;
}> {}

export class InstancesBackupFailed extends Data.TaggedError(
  "GCP.Looker.InstancesBackupFailed",
)<{
  name: string;
  state: string;
}> {}

export class InstancesBackupStillExists extends Data.TaggedError(
  "GCP.Looker.InstancesBackupStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `b${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "backup";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const instanceNameOf = (
  project: string,
  location: string,
  instanceId: string,
) => `projects/${project}/locations/${location}/instances/${instanceId}`;

const resourceName = (instance: string, backupId: string) =>
  `${instance}/backups/${backupId}`;

const parseBackupName = (name: string, fallbackLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const backupsAt = parts.lastIndexOf("backups");
  const instancesAt = parts.lastIndexOf("instances");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const instanceId =
    instancesAt >= 0 && parts[instancesAt + 1] ? parts[instancesAt + 1]! : "";
  const project =
    projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "";
  const location =
    locationsAt >= 0 && parts[locationsAt + 1]
      ? parts[locationsAt + 1]!
      : fallbackLocation;
  return {
    project,
    location,
    instanceId,
    instance:
      instanceId.length > 0
        ? instanceNameOf(project, location, instanceId)
        : "",
    backupId:
      backupsAt >= 0 && parts[backupsAt + 1]
        ? parts[backupsAt + 1]!
        : lastSegment(name),
  };
};

const parseInstanceRef = (
  instance: string,
  fallbackProject: string,
  fallbackLocation: string | undefined,
  region: string,
) => {
  const trimmed = instance.trim();
  if (trimmed.length === 0) {
    return {
      project: fallbackProject,
      location: normalizeLocation(fallbackLocation, region),
      instanceId: "",
      instanceName: "",
    };
  }
  if (trimmed.includes("/instances/") || trimmed.includes("projects/")) {
    const parsed = parseBackupName(
      trimmed.includes("/backups/") ? trimmed : `${trimmed}/backups/-`,
      "",
    );
    const location = normalizeLocation(
      parsed.location || fallbackLocation,
      region,
    );
    const project = parsed.project || fallbackProject;
    return {
      project,
      location,
      instanceId: parsed.instanceId,
      instanceName: instanceNameOf(project, location, parsed.instanceId),
    };
  }
  const location = normalizeLocation(fallbackLocation, region);
  const instanceId = lastSegment(trimmed);
  return {
    project: fallbackProject,
    location,
    instanceId,
    instanceName: instanceNameOf(fallbackProject, location, instanceId),
  };
};

const toEncryptionConfig = (
  config: looker.EncryptionConfig | undefined,
): EncryptionConfig | undefined => {
  if (config === undefined) return undefined;
  if (
    (config.kmsKeyName === undefined || config.kmsKeyName.length === 0) &&
    (config.kmsKeyNameVersion === undefined ||
      config.kmsKeyNameVersion.length === 0) &&
    (config.kmsKeyState === undefined || config.kmsKeyState.length === 0)
  ) {
    return undefined;
  }
  return {
    kmsKeyName: config.kmsKeyName,
    kmsKeyNameVersion: config.kmsKeyNameVersion,
    kmsKeyState: config.kmsKeyState,
  };
};

const isUuid = (value: string) => UUID_RE.test(value);

const isOwnedBackupId = (backupId: string) =>
  backupId.startsWith(OWNERSHIP_PREFIX) && !isUuid(backupId);

const isPlaceholder = (backup: looker.InstanceBackup) => {
  const name = backup.name ?? "";
  return (
    name.length === 0 ||
    name.endsWith("/backups/-") ||
    name.endsWith("/backups/")
  );
};

const isAvailable = (state: string | undefined) =>
  (state ?? "").toUpperCase() === "ACTIVE";

const isFailed = (state: string | undefined) =>
  (state ?? "").toUpperCase() === "FAILED";

const toAttrs = (
  backup: looker.InstanceBackup,
  project: string,
  region: string,
) => {
  const name = backup.name ?? "";
  const parsed = parseBackupName(name, region);
  return {
    name,
    backupId: parsed.backupId,
    instance: parsed.instance,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    location: parsed.location,
    state: backup.state,
    encryptionConfig: toEncryptionConfig(backup.encryptionConfig),
    createTime: backup.createTime,
    expireTime: backup.expireTime,
  };
};

const toId = (id: string, backupId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (backupId !== undefined && backupId.length > 0) return backupId;
    if (existing !== undefined && existing.length > 0) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH - OWNERSHIP_PREFIX.length,
      lowercase: true,
    });
    return rfc1035(`${OWNERSHIP_PREFIX}${generated}`);
  });

const getByName = (name: string) =>
  name.length === 0 || name.includes("//") || name.endsWith("/backups/-")
    ? Effect.succeed(undefined)
    : looker
        .getProjectsLocationsInstancesBackups({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((backup) =>
      backup
        ? Effect.succeed(backup)
        : Effect.fail(new InstancesBackupNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Looker.InstancesBackupNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  Effect.gen(function* () {
    const backup = yield* getByName(name);
    if (backup === undefined) {
      return yield* new InstancesBackupNotReady({ name, state: "MISSING" });
    }
    if (isFailed(backup.state)) {
      return yield* new InstancesBackupFailed({
        name,
        state: backup.state ?? "FAILED",
      });
    }
    if (!isAvailable(backup.state)) {
      return yield* new InstancesBackupNotReady({
        name,
        state: backup.state ?? "STATE_UNSPECIFIED",
      });
    }
    return backup;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.Looker.InstancesBackupNotReady",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((backup) =>
      backup === undefined
        ? Effect.void
        : Effect.fail(new InstancesBackupStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Looker.InstancesBackupStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const listInstanceBackups = (parent: string) =>
  looker.listProjectsLocationsInstancesBackups
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.instanceBackups ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const listOwned = (project: string, region: string) =>
  looker.listProjectsLocationsInstances
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
      Stream.filter((instance) => (instance.name ?? "").length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as looker.Instance[]),
      ),
      Effect.flatMap((instances) =>
        instances.length > 0
          ? Effect.succeed(instances)
          : looker.listProjectsLocationsInstances
              .pages({
                parent: `projects/${project}/locations/${region}`,
                pageSize: 1000,
              })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.instances ?? []),
                ),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as looker.Instance[]),
                ),
              ),
      ),
      Effect.flatMap((instances) =>
        Effect.forEach(
          instances.filter((instance) => (instance.name ?? "").length > 0),
          (instance) => listInstanceBackups(instance.name!),
          { concurrency: 4 },
        ),
      ),
      Effect.map((pages) =>
        pages
          .flat()
          .filter(
            (backup) =>
              !isPlaceholder(backup) &&
              isOwnedBackupId(
                parseBackupName(backup.name ?? "", region).backupId,
              ),
          ),
      ),
    );

export const InstancesBackupProvider = () =>
  Provider.succeed(InstancesBackup, {
    stables: [
      "name",
      "backupId",
      "instance",
      "instanceId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.backupId ?? output?.backupId;
      const nextId = news.backupId ?? previousId;
      const previousInstance = lastSegment(
        olds?.instance ?? output?.instance ?? output?.instanceId,
      );
      const nextInstance = lastSegment(news.instance ?? previousInstance);
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousInstance.length > 0 &&
          nextInstance.length > 0 &&
          previousInstance !== nextInstance) ||
        previousLocation !== nextLocation;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousInstance === nextInstance &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (output?.name) {
        const existing = yield* getByName(output.name);
        if (existing === undefined) return undefined;
        const attrs = toAttrs(existing, env.project, env.region);
        const owned =
          isOwnedBackupId(attrs.backupId) ||
          attrs.name === output.name ||
          attrs.backupId === (olds?.backupId ?? output.backupId);
        return owned ? attrs : Unowned(attrs);
      }
      const backupId = yield* toId(id, olds?.backupId, output?.backupId);
      const ref = parseInstanceRef(
        olds?.instance ?? output?.instance ?? output?.instanceId ?? "",
        env.project,
        olds?.location ?? output?.location,
        env.region,
      );
      if (ref.instanceId.length === 0) return undefined;
      const name = resourceName(ref.instanceName, backupId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return isOwnedBackupId(attrs.backupId) || attrs.backupId === backupId
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
      const backupId = yield* toId(id, news.backupId, output?.backupId);
      const ref = parseInstanceRef(
        news.instance,
        env.project,
        news.location ?? output?.location,
        env.region,
      );
      if (ref.instanceId.length === 0) {
        return yield* new InstancesBackupInstanceMissing({
          message:
            "GCP.Looker.InstancesBackup requires `instance` (instance id or full resource name)",
        });
      }
      const name = resourceName(ref.instanceName, backupId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* looker
          .createProjectsLocationsInstancesBackups({
            parent: ref.instanceName,
            body: { name },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(output?.name ?? name);
      }

      if (current === undefined) {
        return yield* new InstancesBackupNotResolved({ name });
      }

      const currentName = current.name ?? name;
      if (!isAvailable(current.state)) {
        current = yield* waitUntilReady(currentName);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* looker
        .deleteProjectsLocationsInstancesBackups({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
