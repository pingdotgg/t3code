import type {
  EnvironmentResponseVolumeInstancesEdgesItemNode,
  VolumeInstanceBackupListResultItem,
  VolumeInstanceBackupScheduleKind,
  VolumeInstanceResponse,
  VolumeState,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import { ownedProjects } from "./Project.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Volume(...)` and `Volume(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Volume identity a backup snapshots. Accepts a `Railway.Volume` or a
 * `{ volumeInstanceId }` stub.
 */
export type VolumeBackupVolume = {
  readonly volumeInstanceId: string;
  readonly volumeId?: string;
  readonly projectId?: string;
  readonly environmentId?: string;
};

/**
 * Environment identity used to pick a volume instance when the Volume
 * spans more than one. Accepts a `Railway.Project` (primary
 * environment), a `Railway.Environment`, or `{ environmentId }`.
 */
export type VolumeBackupEnvironment = {
  readonly environmentId: string;
};

export type VolumeBackupScheduleKind = VolumeInstanceBackupScheduleKind;

export interface VolumeBackupProps {
  /**
   * Volume to snapshot. Accepts a `Railway.Volume` or a
   * `{ volumeInstanceId }` stub. Changing it replaces the backup.
   */
  volume: Ref<VolumeBackupVolume>;
  /**
   * Environment whose volume instance to snapshot. Defaults to the
   * Volume's environment. Changing it replaces the backup.
   */
  environment?: Ref<VolumeBackupEnvironment>;
  /**
   * Backup name. If omitted, a unique name is generated from the stack,
   * stage and logical ID. Changing it replaces the backup.
   */
  name?: string;
  /**
   * Lock the backup so it does not expire. One-way — Railway has no
   * unlock. Updates in place via `volumeInstanceBackupLock`.
   *
   * @default false
   */
  lock?: boolean;
  /**
   * Backup schedules on the volume instance (`DAILY`, `WEEKLY`,
   * `MONTHLY`). Omit to leave schedules untouched. An empty array
   * clears them. Updates in place via
   * `volumeInstanceBackupScheduleUpdate`.
   */
  schedules?: readonly VolumeBackupScheduleKind[];
}

export type VolumeBackup = Resource<
  "Railway.VolumeBackup",
  VolumeBackupProps,
  {
    /** Railway volume-instance backup id. */
    volumeInstanceBackupId: string;
    /** Volume instance the backup belongs to. */
    volumeInstanceId: string;
    /** Parent volume id, if known. */
    volumeId: string | undefined;
    /** Parent Railway project id, if known. */
    projectId: string | undefined;
    /** Environment the volume instance is in, if known. */
    environmentId: string | undefined;
    /** Backup name (defaults to `'Manual'` on the API). */
    name: string;
    /** RFC3339 creation timestamp. */
    createdAt: string;
    /** RFC3339 expiration, or `undefined` when locked / never expires. */
    expiresAt: string | undefined;
    /** Unique bytes referenced by this backup, in MB. */
    usedMB: number | undefined;
    /** Logical size referenced, in MB. */
    referencedMB: number | undefined;
    /** Size of the volume instance when the backup was taken, in MB. */
    volumeInstanceSizeMB: number | undefined;
    /** Schedule that produced this backup, if it was not manual. */
    scheduleId: string | undefined;
    /** Whether expiration has been removed (`volumeInstanceBackupLock`). */
    locked: boolean;
    /** Observed schedule kinds on the volume instance. */
    schedules: VolumeBackupScheduleKind[];
  },
  never,
  Providers
>;

const resolveVolumeBackupProps = (
  props: VolumeBackupProps | Effect.Effect<VolumeBackupProps, never, Providers>,
): Effect.Effect<VolumeBackupProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const volume = Effect.isEffect(resolved.volume)
      ? yield* resolved.volume as Effect.Effect<
          VolumeBackupVolume,
          never,
          Providers
        >
      : resolved.volume;
    const environment =
      resolved.environment === undefined
        ? undefined
        : Effect.isEffect(resolved.environment)
          ? yield* resolved.environment as Effect.Effect<
              VolumeBackupEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    return { ...resolved, volume, environment };
  });

const VolumeBackupResource = Resource<VolumeBackup>("Railway.VolumeBackup");

/**
 * A Railway.VolumeBackup is a snapshot of a volume instance. Create it
 * next to a `Railway.Volume`. Railway backups run as workflows —
 * Alchemy waits for `workflowStatus` then reads the backup list.
 *
 * Restore is destructive to the volume instance; use
 * {@link restoreVolumeBackup}. Point-in-time restore forks a new
 * Postgres service via {@link restoreVolumePITR}.
 *
 * @see https://docs.railway.com/volumes/backups
 * @see https://docs.railway.com/integrations/api/manage-volumes
 *
 * ### Create a backup
 * Pass the Volume. Alchemy generates a unique name. The volume should
 * be attached to a Service — Railway only backups mounted volumes.
 *
 * **Example:** Manual snapshot
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 * });
 * const data = yield* Railway.Volume("Data", {
 *   project: site,
 *   mountPath: "/data",
 *   service: api,
 * });
 * const snap = yield* Railway.VolumeBackup("Nightly", { volume: data });
 * ```
 *
 * :::caution[Changing `volume` or `environment` replaces the backup]
 * A new snapshot is created on the new instance. The old backup is
 * deleted.
 * :::
 *
 * ### Name
 * Omit `name` for an ownership-stamped name. Pass one to label the
 * snapshot in the dashboard.
 *
 * **Example:** Explicit name
 * ```typescript
 * const snap = yield* Railway.VolumeBackup("Nightly", {
 *   volume: data,
 *   name: "pre-migrate",
 * });
 * ```
 *
 * :::caution[Changing `name` replaces the backup]
 * Railway cannot rename a backup. A new snapshot is created, then the
 * old one is deleted.
 * :::
 *
 * ### Lock
 * Lock to drop the expiration. One-way.
 *
 * **Example:** Lock a backup
 * ```typescript
 * const snap = yield* Railway.VolumeBackup("Nightly", {
 *   volume: data,
 *   lock: true,
 * });
 * ```
 *
 * ### Schedules
 * `schedules` is volume-instance state, not per-snapshot. Set it on
 * one VolumeBackup that owns the instance.
 *
 * **Example:** Daily + weekly
 * ```typescript
 * const snap = yield* Railway.VolumeBackup("Nightly", {
 *   volume: data,
 *   schedules: ["DAILY", "WEEKLY"],
 * });
 * ```
 *
 * ### Restore
 * Restore is not a reconciler step. Call {@link restoreVolumeBackup}
 * (destructive to the instance) or {@link restoreVolumePITR} (forks a
 * new Postgres service).
 *
 * **Example:** Restore a snapshot
 * ```typescript
 * yield* Railway.restoreVolumeBackup({
 *   volumeInstanceId: snap.volumeInstanceId,
 *   volumeInstanceBackupId: snap.volumeInstanceBackupId,
 * });
 * ```
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope backup
 * ```typescript
 * // src/data.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Data = Railway.Volume("Data", {
 *   project: Site,
 *   mountPath: "/data",
 * });
 * export const Nightly = Railway.VolumeBackup("Nightly", {
 *   volume: Data,
 * });
 * ```
 *
 * @resource
 */
export const VolumeBackup: typeof VolumeBackupResource = Object.assign(
  (
    id: string,
    props:
      | VolumeBackupProps
      | Effect.Effect<VolumeBackupProps, never, Providers>,
  ) => VolumeBackupResource(id, resolveVolumeBackupProps(props)),
  VolumeBackupResource,
);

export class VolumeBackupNotCreated extends Data.TaggedError(
  "Railway.VolumeBackupNotCreated",
)<{
  name: string;
  volumeInstanceId: string;
}> {}

export class VolumeBackupVolumeRequired extends Data.TaggedError(
  "Railway.VolumeBackupVolumeRequired",
)<{
  message: string;
}> {}

export class VolumeBackupWorkflowFailed extends Data.TaggedError(
  "Railway.VolumeBackupWorkflowFailed",
)<{
  workflowId: string;
  error: string;
}> {}

class VolumeBackupPending extends Data.TaggedError(
  "Railway.VolumeBackupPending",
)<{
  volumeInstanceId: string;
  state: string;
}> {}

type CloudBackup = VolumeInstanceBackupListResultItem;
type CloudInstance =
  | EnvironmentResponseVolumeInstancesEdgesItemNode
  | VolumeInstanceResponse;

const volumeInstanceIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { volumeInstanceId?: unknown };
  return typeof rec.volumeInstanceId === "string" &&
    rec.volumeInstanceId.length > 0
    ? rec.volumeInstanceId
    : undefined;
};

const volumeIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { volumeId?: unknown };
  return typeof rec.volumeId === "string" && rec.volumeId.length > 0
    ? rec.volumeId
    : undefined;
};

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const goneState = (state: VolumeState | null | undefined) =>
  state === "DELETED" || state === "DELETING";

const transientState = (state: VolumeState | null | undefined) =>
  state === "UPDATING" ||
  state === "MIGRATING" ||
  state === "MIGRATION_PENDING" ||
  state === "RESTORING";

const isGoneInstance = (instance: CloudInstance | undefined) =>
  instance === undefined ||
  instance.deletedAt != null ||
  instance.isPendingDeletion ||
  goneState(instance.state);

const uniqueKinds = (
  kinds: readonly VolumeBackupScheduleKind[],
): VolumeBackupScheduleKind[] => {
  const seen = new Set<VolumeBackupScheduleKind>();
  const out: VolumeBackupScheduleKind[] = [];
  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push(kind);
  }
  return out;
};

const kindsKey = (kinds: readonly VolumeBackupScheduleKind[]) =>
  [...kinds].slice().sort().join(",");

const resolveName = (id: string, existing?: string) =>
  Effect.gen(function* () {
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createRailwayName(id);
  });

const listBackups = (volumeInstanceId: string) =>
  railway
    .volumeInstanceBackupList({ volumeInstanceId })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed([] as VolumeInstanceBackupListResultItem[]),
      ),
    );

const listSchedules = (volumeInstanceId: string) =>
  railway.volumeInstanceBackupScheduleList({ volumeInstanceId }).pipe(
    Effect.map((items) => uniqueKinds(items.map((item) => item.kind))),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as VolumeBackupScheduleKind[]),
    ),
  );

const toAttrs = (
  backup: CloudBackup,
  context: {
    volumeInstanceId: string;
    volumeId?: string;
    projectId?: string;
    environmentId?: string;
    schedules?: VolumeBackupScheduleKind[];
  },
): VolumeBackup["Attributes"] => ({
  volumeInstanceBackupId: backup.id,
  volumeInstanceId: context.volumeInstanceId,
  volumeId: context.volumeId,
  projectId: context.projectId,
  environmentId: context.environmentId,
  name: backup.name ?? "",
  createdAt: backup.createdAt,
  expiresAt: backup.expiresAt ?? undefined,
  usedMB: backup.usedMB ?? undefined,
  referencedMB: backup.referencedMB ?? undefined,
  volumeInstanceSizeMB: backup.volumeInstanceSizeMB ?? undefined,
  scheduleId: backup.scheduleId ?? undefined,
  locked: backup.expiresAt == null,
  schedules: context.schedules ?? [],
});

const findBackup = (
  backups: readonly CloudBackup[],
  match: { id?: string; name?: string },
) => {
  if (match.id !== undefined && match.id.length > 0) {
    const byId = backups.find((backup) => backup.id === match.id);
    if (byId !== undefined) return byId;
  }
  if (match.name !== undefined && match.name.length > 0) {
    return backups.find((backup) => backup.name === match.name);
  }
  return undefined;
};

const getByInstanceId = (volumeInstanceId: string) =>
  railway.volumeInstance({ id: volumeInstanceId }).pipe(
    Effect.map((instance) => (isGoneInstance(instance) ? undefined : instance)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const listVolumeInstances = (environmentId: string, projectId: string) =>
  railway.environment({ id: environmentId, projectId }).pipe(
    Effect.map((env) =>
      env.deletedAt != null
        ? []
        : env.volumeInstances.edges
            .map((edge) => edge.node)
            .filter((node) => !isGoneInstance(node)),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as EnvironmentResponseVolumeInstancesEdgesItemNode[]),
    ),
  );

const listEnvironmentIds = (project: {
  projectId: string;
  environmentId: string;
}) =>
  railway.environments.items({ projectId: project.projectId, first: 50 }).pipe(
    Stream.filter((env) => env.deletedAt == null),
    Stream.map((env) => env.id),
    Stream.runCollect,
    Effect.map((ids) => {
      const set = new Set(Array.from(ids));
      if (project.environmentId.length > 0) {
        set.add(project.environmentId);
      }
      return Array.from(set);
    }),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(
        project.environmentId.length > 0 ? [project.environmentId] : [],
      ),
    ),
  );

const waitForWorkflow = (
  workflowId: string,
  volumeInstanceId: string,
  mode: "create" | "delete",
) =>
  Effect.gen(function* () {
    const result = yield* railway.workflowStatus({ workflowId }).pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({
          status: "NotFound",
          error: null,
        } as const),
      ),
    );
    if (result.status === "Complete") return result;
    if (result.status === "Error") {
      return yield* new VolumeBackupWorkflowFailed({
        workflowId,
        error: result.error ?? "backup workflow failed",
      });
    }
    return yield* new VolumeBackupPending({
      volumeInstanceId,
      state: result.status,
    });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Railway.VolumeBackupPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("Railway.VolumeBackupPending", () =>
      mode === "delete"
        ? Effect.void
        : Effect.fail(
            new VolumeBackupWorkflowFailed({
              workflowId,
              error: "timed out waiting for backup workflow",
            }),
          ),
    ),
  );

const instanceReady = (instance: CloudInstance | undefined) =>
  instance !== undefined &&
  !isGoneInstance(instance) &&
  !transientState(instance.state) &&
  instance.state !== "ERROR";

const waitUntilReady = (volumeInstanceId: string) =>
  getByInstanceId(volumeInstanceId).pipe(
    Effect.flatMap((instance) => {
      if (!instanceReady(instance)) {
        return Effect.fail(
          new VolumeBackupPending({
            volumeInstanceId,
            state: instance?.state ?? "missing",
          }),
        );
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.VolumeBackupPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("Railway.VolumeBackupPending", () =>
      getByInstanceId(volumeInstanceId),
    ),
  );

const waitForBackup = (input: {
  volumeInstanceId: string;
  name: string;
  id?: string;
  previousIds: ReadonlySet<string>;
}) =>
  listBackups(input.volumeInstanceId).pipe(
    Effect.flatMap((backups) => {
      const found =
        findBackup(backups, { id: input.id, name: input.name }) ??
        backups.find((backup) => !input.previousIds.has(backup.id));
      if (found === undefined) {
        return Effect.fail(
          new VolumeBackupPending({
            volumeInstanceId: input.volumeInstanceId,
            state: "creating",
          }),
        );
      }
      return Effect.succeed(found);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.VolumeBackupPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("Railway.VolumeBackupPending", () =>
      listBackups(input.volumeInstanceId).pipe(
        Effect.map(
          (backups) =>
            findBackup(backups, { id: input.id, name: input.name }) ??
            backups.find((backup) => !input.previousIds.has(backup.id)),
        ),
      ),
    ),
  );

const waitUntilGone = (
  volumeInstanceId: string,
  volumeInstanceBackupId: string,
) =>
  listBackups(volumeInstanceId).pipe(
    Effect.map(
      (backups) =>
        !backups.some((backup) => backup.id === volumeInstanceBackupId),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

const observeInstance = Effect.fn(function* (input: {
  volumeInstanceId?: string;
  volumeId?: string;
  projectId?: string;
  environmentId?: string;
}) {
  if (
    input.volumeInstanceId !== undefined &&
    input.volumeInstanceId.length > 0
  ) {
    const byId = yield* getByInstanceId(input.volumeInstanceId);
    if (byId !== undefined) return byId;
  }
  if (
    input.environmentId !== undefined &&
    input.projectId !== undefined &&
    input.volumeId !== undefined
  ) {
    const instances = yield* listVolumeInstances(
      input.environmentId,
      input.projectId,
    );
    return instances.find((instance) => instance.volumeId === input.volumeId);
  }
  return undefined;
});

/**
 * Restore a volume instance from a backup. Destructive to the live
 * volume — the instance is overwritten. Waits for the restore workflow.
 */
export const restoreVolumeBackup = Effect.fn(function* (input: {
  volumeInstanceId: string;
  volumeInstanceBackupId: string;
}) {
  const result = yield* railway.volumeInstanceBackupRestore({
    volumeInstanceBackupId: input.volumeInstanceBackupId,
    volumeInstanceId: input.volumeInstanceId,
  });
  if (result.workflowId != null && result.workflowId.length > 0) {
    yield* waitForWorkflow(result.workflowId, input.volumeInstanceId, "create");
  }
  return result;
});

/**
 * Point-in-time restore. Creates a new Postgres service whose volume
 * is populated from the source archive. The source service is left
 * online.
 */
export const restoreVolumePITR = Effect.fn(function* (input: {
  volumeInstanceId: string;
  targetTimestamp: string;
  newServiceName?: string;
  sourceRepoPath?: string;
}) {
  const result = yield* railway.volumeInstancePITRRestore({
    volumeInstanceId: input.volumeInstanceId,
    targetTimestamp: input.targetTimestamp,
    ...(input.newServiceName !== undefined
      ? { newServiceName: input.newServiceName }
      : {}),
    ...(input.sourceRepoPath !== undefined
      ? { sourceRepoPath: input.sourceRepoPath }
      : {}),
  });
  if (result.workflowId != null && result.workflowId.length > 0) {
    yield* waitForWorkflow(result.workflowId, input.volumeInstanceId, "create");
  }
  return result;
});

export const VolumeBackupProvider = () =>
  Provider.succeed(VolumeBackup, {
    stables: [
      "volumeInstanceBackupId",
      "volumeInstanceId",
      "volumeId",
      "projectId",
      "environmentId",
      "createdAt",
    ],
    nuke: { dependsOn: ["Railway.Volume", "Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const nextInstance = volumeInstanceIdOf(news.volume);
      const instanceChanged =
        nextInstance !== undefined && nextInstance !== output.volumeInstanceId;
      const nextEnv = environmentIdOf(news.environment);
      const environmentChanged =
        nextEnv !== undefined &&
        output.environmentId !== undefined &&
        nextEnv !== output.environmentId;
      const nextVolumeId = volumeIdOf(news.volume);
      const volumeChanged =
        nextVolumeId !== undefined &&
        output.volumeId !== undefined &&
        nextVolumeId !== output.volumeId;
      const nameChanged =
        news.name !== undefined &&
        news.name.length > 0 &&
        news.name !== output.name;
      if (
        instanceChanged ||
        environmentChanged ||
        volumeChanged ||
        nameChanged
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const volumeInstanceId =
        output?.volumeInstanceId ??
        (olds !== undefined ? volumeInstanceIdOf(olds.volume) : undefined);
      const name = yield* resolveName(id, output?.name ?? olds?.name);
      if (volumeInstanceId === undefined) return undefined;
      const backups = yield* listBackups(volumeInstanceId);
      const found = findBackup(backups, {
        id: output?.volumeInstanceBackupId,
        name,
      });
      if (found === undefined) return undefined;
      const schedules = yield* listSchedules(volumeInstanceId);
      const attrs = toAttrs(found, {
        volumeInstanceId,
        volumeId:
          output?.volumeId ??
          (olds !== undefined ? volumeIdOf(olds.volume) : undefined),
        projectId:
          output?.projectId ??
          (olds !== undefined ? projectIdOf(olds.volume) : undefined),
        environmentId:
          output?.environmentId ??
          (olds !== undefined
            ? (environmentIdOf(olds.environment) ??
              environmentIdOf(olds.volume))
            : undefined),
        schedules,
      });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.name ?? undefined)
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const envRows = yield* railway.environments
            .items({ projectId: project.projectId, first: 50 })
            .pipe(
              Stream.filter((env) => env.deletedAt == null),
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
                Effect.succeed([]),
              ),
            );
          const instances = envRows.flatMap((env) =>
            env.volumeInstances.edges
              .map((edge) => edge.node)
              .filter(
                (instance) =>
                  instance.deletedAt == null &&
                  matchesAlchemyPhysicalName(instance.volume.name),
              ),
          );
          const nested = yield* Effect.forEach(instances, (instance) =>
            Effect.gen(function* () {
              const backups = yield* listBackups(instance.id);
              const schedules = yield* listSchedules(instance.id);
              return backups.map((backup) =>
                toAttrs(backup, {
                  volumeInstanceId: instance.id,
                  volumeId: instance.volumeId,
                  projectId: instance.volume.projectId,
                  environmentId: instance.environmentId,
                  schedules,
                }),
              );
            }),
          );
          return nested.flat();
        }),
      );
      const seen = new Set<string>();
      const unique: VolumeBackup["Attributes"][] = [];
      for (const row of rows.flat()) {
        if (seen.has(row.volumeInstanceBackupId)) continue;
        seen.add(row.volumeInstanceBackupId);
        unique.push(row);
      }
      return unique;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as VolumeBackupProps);
      const environmentId =
        environmentIdOf(props.environment) ??
        environmentIdOf(props.volume) ??
        output?.environmentId;
      const projectId = projectIdOf(props.volume) ?? output?.projectId;
      const volumeId = volumeIdOf(props.volume) ?? output?.volumeId;
      let volumeInstanceId =
        volumeInstanceIdOf(props.volume) ?? output?.volumeInstanceId;

      const instance = yield* observeInstance({
        volumeInstanceId,
        volumeId,
        projectId,
        environmentId,
      });
      if (instance !== undefined) {
        volumeInstanceId = instance.id;
      }
      if (volumeInstanceId === undefined || volumeInstanceId.length === 0) {
        return yield* new VolumeBackupVolumeRequired({
          message:
            "VolumeBackup requires a resolved Railway.Volume (volumeInstanceId)",
        });
      }

      const name = yield* resolveName(id, props.name ?? output?.name);
      const resolvedVolumeId = instance?.volumeId ?? volumeId;
      const resolvedProjectId = instance?.volume.projectId ?? projectId;
      const resolvedEnvironmentId = instance?.environmentId ?? environmentId;

      let current: CloudBackup | undefined;
      const existing = yield* listBackups(volumeInstanceId);
      current = findBackup(existing, {
        id: output?.volumeInstanceBackupId,
        name,
      });

      if (current === undefined) {
        const ready = yield* waitUntilReady(volumeInstanceId);
        if (ready === undefined || isGoneInstance(ready)) {
          return yield* new VolumeBackupNotCreated({
            name,
            volumeInstanceId,
          });
        }
        const previousIds = new Set(existing.map((backup) => backup.id));
        const created = yield* railway.volumeInstanceBackupCreate({
          volumeInstanceId,
          name,
        });
        if (created.workflowId != null && created.workflowId.length > 0) {
          yield* waitForWorkflow(
            created.workflowId,
            volumeInstanceId,
            "create",
          );
        }
        current = yield* waitForBackup({
          volumeInstanceId,
          name,
          previousIds,
        });
      }

      if (current === undefined) {
        return yield* new VolumeBackupNotCreated({
          name,
          volumeInstanceId,
        });
      }

      if (props.lock === true && current.expiresAt != null) {
        yield* railway.volumeInstanceBackupLock({
          volumeInstanceBackupId: current.id,
          volumeInstanceId,
        });
        const locked = yield* listBackups(volumeInstanceId).pipe(
          Effect.map((backups) =>
            findBackup(backups, { id: current!.id, name }),
          ),
        );
        if (locked !== undefined) current = locked;
      }

      let schedules = yield* listSchedules(volumeInstanceId);
      if (props.schedules !== undefined) {
        const desired = uniqueKinds(props.schedules);
        if (kindsKey(desired) !== kindsKey(schedules)) {
          yield* railway.volumeInstanceBackupScheduleUpdate({
            volumeInstanceId,
            kinds: desired,
          });
          schedules = yield* listSchedules(volumeInstanceId);
        }
      }

      return toAttrs(current, {
        volumeInstanceId,
        volumeId: resolvedVolumeId,
        projectId: resolvedProjectId,
        environmentId: resolvedEnvironmentId,
        schedules,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      const volumeInstanceBackupId = output.volumeInstanceBackupId;
      const volumeInstanceId = output.volumeInstanceId;
      if (
        volumeInstanceBackupId.length === 0 ||
        volumeInstanceId.length === 0
      ) {
        return;
      }
      const deleted = yield* railway
        .volumeInstanceBackupDelete({
          volumeInstanceBackupId,
          volumeInstanceId,
        })
        .pipe(
          Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
            Effect.succeed({ workflowId: null as string | null }),
          ),
        );
      if (deleted.workflowId != null && deleted.workflowId.length > 0) {
        yield* waitForWorkflow(deleted.workflowId, volumeInstanceId, "delete");
      }
      yield* waitUntilGone(volumeInstanceId, volumeInstanceBackupId);
    }),
  });
