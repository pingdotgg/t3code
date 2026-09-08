import type {
  FlyMachineConfig,
  FlyMachineMount,
  FlyMachineService,
  ImageRef as FlyImageRef,
  Machine as FlyMachine,
  Volume as FlyVolume,
} from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { listOwnedApps } from "./App.ts";
import type { MachineGuest, MachineImageRef } from "./Machine.ts";
import {
  alchemyMetadataKeys,
  createMachineMetadata,
  isAlchemyOwnedMetadata,
  sanitizeFlyAppName,
  type FlyAlchemyType,
} from "./Metadata.ts";
import type { DiskSpec, MountedDisk } from "./MountVolume.ts";
import {
  deleteVolume,
  ensureVolumeGroup,
  getVolumeById,
  volumeGroupName,
} from "./Volume.ts";

const WAIT_TIMEOUT_SECONDS = 8;
const waitBackoff = Schedule.exponential("500 millis");

export class ReplicaNotCreated extends Data.TaggedError(
  "Fly.ReplicaNotCreated",
)<{
  name: string;
  appName: string;
}> {}

export interface Replica {
  machineId: string;
  name: string;
  region: string;
  state: string;
  instanceId: string | undefined;
  privateIp: string | undefined;
  imageRef: MachineImageRef | undefined;
  guest: MachineGuest | undefined;
  mounts: MountedDisk[];
}

export interface ReplicaSet {
  appName: string;
  machineId: string;
  machineIds: string[];
  name: string;
  region: string;
  state: string;
  instanceId: string | undefined;
  privateIp: string | undefined;
  imageRef: MachineImageRef | undefined;
  guest: MachineGuest | undefined;
  url: string | undefined;
  count: number;
  mounts: MountedDisk[];
  replicas: Replica[];
}

const compactRecord = (
  record: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );

export const gone = (machine: FlyMachine | undefined) =>
  machine === undefined || machine.state === "destroyed";

export const getMachineById = (appName: string, machineId: string) =>
  machines.getMachine({ app_name: appName, machine_id: machineId }).pipe(
    Effect.map((machine) => (gone(machine) ? undefined : machine)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const listMachinesByApp = (appName: string) =>
  machines.listMachines({ app_name: appName }).pipe(
    Effect.map((machines) => machines.filter((machine) => !gone(machine))),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([])),
  );

export const resolveCount = (count: number | undefined) =>
  Math.max(1, Math.floor(count ?? 1));

export const replicaMachineName = (
  base: string,
  index: number,
  count: number,
) => {
  if (count <= 1 && index === 0) return base;
  const suffix = `-${index}`;
  const room = 30 - suffix.length;
  const clipped = base.slice(0, Math.max(1, room)).replace(/-+$/g, "");
  return sanitizeFlyAppName(`${clipped}${suffix}`);
};

export const replicaIndexOf = (machine: FlyMachine): number => {
  const raw = compactRecord(machine.config?.metadata)[
    alchemyMetadataKeys.replica
  ];
  const parsed = raw === undefined ? 0 : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const alchemyIdOf = (machine: FlyMachine): string | undefined => {
  const id = compactRecord(machine.config?.metadata)[alchemyMetadataKeys.id];
  return id !== undefined && id.length > 0 ? id : undefined;
};

export const isOwnedType = (machine: FlyMachine, type: FlyAlchemyType) => {
  const metadata = compactRecord(machine.config?.metadata);
  return (
    isAlchemyOwnedMetadata(metadata) &&
    metadata[alchemyMetadataKeys.type] === type
  );
};

export const toImageRef = (
  ref: FlyImageRef | undefined,
): MachineImageRef | undefined => {
  if (ref === undefined) return undefined;
  const imageRef: MachineImageRef = {
    registry: ref.registry,
    repository: ref.repository,
    tag: ref.tag,
    digest: ref.digest,
  };
  return imageRef.registry === undefined &&
    imageRef.repository === undefined &&
    imageRef.tag === undefined &&
    imageRef.digest === undefined
    ? undefined
    : imageRef;
};

export const toGuestAttrs = (
  guest:
    | {
        cpu_kind?: string;
        cpus?: number;
        memory_mb?: number;
        gpu_kind?: string;
        gpus?: number;
      }
    | undefined,
): MachineGuest | undefined => {
  if (guest === undefined) return undefined;
  return {
    cpuKind: guest.cpu_kind,
    cpus: guest.cpus,
    memoryMb: guest.memory_mb,
    gpuKind: guest.gpu_kind,
    gpus: guest.gpus,
  };
};

export const hasPublishedService = (
  services: FlyMachineService[] | undefined,
) =>
  (services ?? []).some((service) =>
    (service.ports ?? []).some(
      (port) => port.port !== undefined || port.start_port !== undefined,
    ),
  );

export const waitStarted = (appName: string, machineId: string) =>
  machines
    .waitMachine({
      app_name: appName,
      machine_id: machineId,
      state: "started",
      timeout: WAIT_TIMEOUT_SECONDS,
    })
    .pipe(
      Effect.retry({
        times: 6,
        schedule: waitBackoff,
        while: (e) => e._tag === "GatewayTimeout",
      }),
      Effect.timeout("50 seconds"),
    );

export const waitDestroyed = (appName: string, machineId: string) =>
  machines
    .waitMachine({
      app_name: appName,
      machine_id: machineId,
      state: "destroyed",
      timeout: WAIT_TIMEOUT_SECONDS,
    })
    .pipe(
      Effect.as(undefined),
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.retry({
        times: 6,
        schedule: waitBackoff,
        while: (e) => e._tag === "GatewayTimeout",
      }),
    );

export const ensureStarted = Effect.fn(function* (
  appName: string,
  machine: FlyMachine,
  skipLaunch: boolean,
) {
  const machineId = machine.id;
  if (machineId === undefined || skipLaunch) return machine;
  const state = machine.state;
  if (state !== "started" && state !== "starting") {
    yield* machines
      .startMachine({
        app_name: appName,
        machine_id: machineId,
      })
      .pipe(Effect.catchTag(["NotFound", "Conflict"], () => Effect.void));
  }
  yield* waitStarted(appName, machineId);
  return (yield* getMachineById(appName, machineId)) ?? machine;
});

export const deleteMachine = Effect.fn(function* (
  appName: string,
  machineId: string,
) {
  if (appName.length === 0 || machineId.length === 0) return;
  yield* machines
    .deleteMachine({
      app_name: appName,
      machine_id: machineId,
      force: true,
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.retry({
        while: (e) => e._tag === "Conflict",
        times: 6,
        schedule: waitBackoff,
      }),
    );
  yield* waitDestroyed(appName, machineId);
});

const mountedDisksOf = (
  machine: FlyMachine,
  volumesById: Map<string, FlyVolume>,
): MountedDisk[] =>
  (machine.config?.mounts ?? []).flatMap((mount) => {
    const volumeId = mount.volume;
    const path = mount.path;
    if (volumeId === undefined || path === undefined) return [];
    const volume = volumesById.get(volumeId);
    return [
      {
        path,
        volumeId,
        sizeGb: volume?.size_gb ?? 0,
        name: volume?.name ?? "",
      },
    ];
  });

export const toReplica = (
  machine: FlyMachine,
  volumesById: Map<string, FlyVolume>,
): Replica => ({
  machineId: machine.id ?? "",
  name: machine.name ?? "",
  region: machine.region ?? "",
  state: machine.state ?? "",
  instanceId: machine.instance_id,
  privateIp: machine.private_ip,
  imageRef: toImageRef(machine.image_ref),
  guest: toGuestAttrs(machine.config?.guest),
  mounts: mountedDisksOf(machine, volumesById),
});

export const toReplicaSet = (
  replicas: Replica[],
  appName: string,
  baseName: string,
  services?: FlyMachineService[],
): ReplicaSet => {
  const primary = replicas[0];
  return {
    appName,
    machineId: primary?.machineId ?? "",
    machineIds: replicas.map((replica) => replica.machineId),
    name: primary?.name ?? baseName,
    region: primary?.region ?? "",
    state: primary?.state ?? "",
    instanceId: primary?.instanceId,
    privateIp: primary?.privateIp,
    imageRef: primary?.imageRef,
    guest: primary?.guest,
    url: hasPublishedService(services)
      ? `https://${appName}.fly.dev`
      : undefined,
    count: replicas.length,
    mounts: primary?.mounts ?? [],
    replicas,
  };
};

export const listReplicas = Effect.fn(function* (input: {
  appName: string;
  id: string;
  type: FlyAlchemyType;
}) {
  const machines = yield* listMachinesByApp(input.appName);
  return machines
    .filter(
      (machine) =>
        isOwnedType(machine, input.type) && alchemyIdOf(machine) === input.id,
    )
    .sort((left, right) => replicaIndexOf(left) - replicaIndexOf(right));
});

export const listReplicaSets = Effect.fn(function* (type: FlyAlchemyType) {
  const apps = yield* listOwnedApps();
  const groups = yield* Effect.forEach(
    apps,
    (app) =>
      listMachinesByApp(app.appName).pipe(
        Effect.map((machines) => {
          const owned = machines.filter((machine) =>
            isOwnedType(machine, type),
          );
          const byId = new Map<string, FlyMachine[]>();
          for (const machine of owned) {
            const id = alchemyIdOf(machine);
            if (id === undefined) continue;
            const group = byId.get(id) ?? [];
            group.push(machine);
            byId.set(id, group);
          }
          return [...byId.values()].map((group) => {
            const sorted = [...group].sort(
              (left, right) => replicaIndexOf(left) - replicaIndexOf(right),
            );
            const replicas = sorted.map((machine) =>
              toReplica(machine, new Map()),
            );
            return toReplicaSet(
              replicas,
              app.appName,
              replicas[0]?.name ?? "",
              sorted[0]?.config?.services,
            );
          });
        }),
      ),
    { concurrency: 8 },
  );
  return groups.flat();
});

const pickVolume = (
  group: FlyVolume[],
  used: Set<string>,
  preferId: string | undefined,
): FlyVolume | undefined => {
  if (preferId !== undefined && !used.has(preferId)) {
    const preferred = group.find((volume) => volume.id === preferId);
    if (preferred !== undefined) return preferred;
  }
  return group.find(
    (volume) => volume.id !== undefined && !used.has(volume.id),
  );
};

export const reconcileReplicas = Effect.fn(function* (input: {
  id: string;
  type: FlyAlchemyType;
  appName: string;
  baseName: string;
  region: string;
  count: number;
  disks: DiskSpec[];
  skipLaunch?: boolean;
  minSecretsVersion?: number;
  outputMachineIds?: readonly string[];
  preferVolumeIds?: ReadonlyArray<ReadonlyArray<string>>;
  configDrifted: (
    machine: FlyMachine,
    desired: {
      mounts: FlyMachineMount[];
      metadata: Record<string, string>;
    },
  ) => boolean;
  buildConfig: (replica: {
    index: number;
    mounts: FlyMachineMount[];
    metadata: Record<string, string>;
  }) => FlyMachineConfig;
}) {
  const alchemy = yield* createMachineMetadata(input.id, input.type);
  const desiredNames = new Set(
    Array.from({ length: input.count }, (_, index) =>
      replicaMachineName(input.baseName, index, input.count),
    ),
  );
  const listed = yield* listMachinesByApp(input.appName);
  const owned = listed.filter((machine) => isOwnedType(machine, input.type));
  const byIndex = new Map<number, FlyMachine>();
  const preferIds = new Set(
    (input.outputMachineIds ?? []).filter((id) => id.length > 0),
  );
  for (const machine of owned) {
    const id = machine.id;
    if (id !== undefined && preferIds.has(id)) {
      byIndex.set(replicaIndexOf(machine), machine);
    }
  }
  for (const machine of owned) {
    const name = machine.name;
    if (name === undefined || !desiredNames.has(name)) continue;
    const index = replicaIndexOf(machine);
    if (!byIndex.has(index)) byIndex.set(index, machine);
  }

  for (const [index, machine] of byIndex) {
    if (index >= input.count && machine.id !== undefined) {
      yield* deleteMachine(input.appName, machine.id);
      byIndex.delete(index);
    }
  }

  const groups: Array<{
    disk: DiskSpec;
    name: string;
    volumes: FlyVolume[];
    extras: FlyVolume[];
  }> = [];
  for (const [diskIndex, disk] of input.disks.entries()) {
    const name = yield* volumeGroupName(input.id, disk);
    const preferIds = (input.preferVolumeIds ?? [])
      .map((replica) => replica[diskIndex])
      .filter((id): id is string => id !== undefined && id.length > 0);
    const ensured = yield* ensureVolumeGroup({
      appName: input.appName,
      name,
      region: input.region,
      count: input.count,
      disk,
      preferIds,
    });
    groups.push({ disk, name, ...ensured });
  }

  const usedVolumeIds = new Set<string>();
  const live: FlyMachine[] = [];
  for (let index = 0; index < input.count; index++) {
    const name = replicaMachineName(input.baseName, index, input.count);
    const metadata = {
      ...alchemy,
      [alchemyMetadataKeys.replica]: String(index),
    };
    const prefer = input.preferVolumeIds?.[index] ?? [];
    const mounts: FlyMachineMount[] = [];
    for (const [diskIndex, group] of groups.entries()) {
      const volume = pickVolume(
        group.volumes,
        usedVolumeIds,
        prefer[diskIndex],
      );
      const volumeId = volume?.id;
      if (volumeId === undefined) {
        return yield* new ReplicaNotCreated({
          name,
          appName: input.appName,
        });
      }
      usedVolumeIds.add(volumeId);
      mounts.push({ volume: volumeId, path: group.disk.path });
    }
    const config = input.buildConfig({ index, mounts, metadata });
    let current = byIndex.get(index);
    if (current === undefined) {
      const created = yield* machines
        .createMachine({
          app_name: input.appName,
          name,
          region: input.region,
          config,
          skip_launch: input.skipLaunch === true ? true : undefined,
          min_secrets_version: input.minSecretsVersion,
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
      current =
        created ??
        (yield* listMachinesByApp(input.appName).pipe(
          Effect.map((machines) =>
            machines.find((machine) => machine.name === name),
          ),
        ));
      if (current === undefined || current.id === undefined) {
        return yield* new ReplicaNotCreated({
          name,
          appName: input.appName,
        });
      }
    } else if (
      input.configDrifted(current, {
        mounts,
        metadata,
      })
    ) {
      const updated = yield* machines
        .updateMachine({
          app_name: input.appName,
          machine_id: current.id ?? "",
          config,
          skip_launch: input.skipLaunch === true ? true : undefined,
          min_secrets_version: input.minSecretsVersion,
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
      if (updated !== undefined) current = updated;
    }

    current = yield* ensureStarted(
      input.appName,
      current,
      input.skipLaunch === true,
    );
    live.push(current);
  }

  for (const group of groups) {
    for (const extra of group.extras) {
      const volumeId = extra.id;
      if (volumeId === undefined || usedVolumeIds.has(volumeId)) continue;
      yield* deleteVolume(input.appName, volumeId);
    }
  }

  const volumesById = new Map<string, FlyVolume>();
  for (const group of groups) {
    for (const volume of group.volumes) {
      if (volume.id !== undefined) volumesById.set(volume.id, volume);
    }
  }
  const fresh = yield* Effect.forEach(
    live,
    (machine) =>
      machine.id === undefined
        ? Effect.succeed(machine)
        : getMachineById(input.appName, machine.id).pipe(
            Effect.map((next) => next ?? machine),
          ),
    { concurrency: 4 },
  );
  const replicas = fresh.map((machine) => toReplica(machine, volumesById));
  return toReplicaSet(
    replicas,
    input.appName,
    input.baseName,
    fresh[0]?.config?.services,
  );
});

export const deleteReplicaSet = Effect.fn(function* (input: {
  appName: string;
  machineIds: readonly string[];
  volumeIds: readonly string[];
}) {
  yield* Effect.forEach(
    input.machineIds.filter((id) => id.length > 0),
    (machineId) => deleteMachine(input.appName, machineId),
    { concurrency: 4 },
  );
  yield* Effect.forEach(
    [...new Set(input.volumeIds)].filter((id) => id.length > 0),
    (volumeId) => deleteVolume(input.appName, volumeId),
    { concurrency: 4 },
  );
});

export const volumeIdsOf = (set: {
  mounts?: readonly MountedDisk[];
  replicas?: readonly Replica[];
}): string[] => {
  const ids = new Set<string>();
  for (const mount of set.mounts ?? []) ids.add(mount.volumeId);
  for (const replica of set.replicas ?? []) {
    for (const mount of replica.mounts) ids.add(mount.volumeId);
  }
  return [...ids];
};

export const observeReplicaSet = Effect.fn(function* (input: {
  appName?: string;
  id: string;
  type: FlyAlchemyType;
  machineIds?: readonly string[];
  baseName?: string;
}) {
  if (input.appName === undefined) return undefined;
  const listed = (yield* listReplicas({
    appName: input.appName,
    id: input.id,
    type: input.type,
  })).filter((machine) => {
    if (input.baseName === undefined) return true;
    const name = machine.name ?? "";
    if (name === input.baseName) return true;
    return name.startsWith(`${input.baseName}-`);
  });
  if (listed.length > 0) {
    const volumesById = new Map<string, FlyVolume>();
    for (const machine of listed) {
      for (const mount of machine.config?.mounts ?? []) {
        const volumeId = mount.volume;
        if (volumeId === undefined || volumesById.has(volumeId)) continue;
        const volume = yield* getVolumeById(input.appName, volumeId);
        if (volume !== undefined) volumesById.set(volumeId, volume);
      }
    }
    const replicas = listed.map((machine) => toReplica(machine, volumesById));
    return toReplicaSet(
      replicas,
      input.appName,
      replicas[0]?.name ?? "",
      listed[0]?.config?.services,
    );
  }
  const ids = (input.machineIds ?? []).filter((id) => id.length > 0);
  if (ids.length === 0) return undefined;
  const found = yield* Effect.forEach(
    ids,
    (machineId) => getMachineById(input.appName!, machineId),
    { concurrency: 4 },
  );
  const machines = found.filter(
    (machine): machine is FlyMachine => machine !== undefined,
  );
  if (machines.length === 0) return undefined;
  return toReplicaSet(
    machines.map((machine) => toReplica(machine, new Map())),
    input.appName,
    machines[0]?.name ?? "",
    machines[0]?.config?.services,
  );
});
