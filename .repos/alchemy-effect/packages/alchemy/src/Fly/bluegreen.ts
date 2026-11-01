import { regionOfReplica } from "./Region.ts";
import * as machines from "@distilled.cloud/fly-io/machines";
import type { Machine } from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual } from "../Diff.ts";
import { sha256Object } from "../Util/sha256.ts";
import { canonicalContainers } from "./MachineContainers.ts";
import { alchemyMetadataKeys as keys } from "./Metadata.ts";
import {
  applyImageSet,
  encodeImageSet,
  pinsFromConfig,
  sameImageSet,
  validObservedImageSet,
} from "./DeploymentImages.ts";
import {
  classifyDeploymentState,
  validProtocol2Generation,
} from "./DeploymentState.ts";
import { usingMachineLeases, type MachineLeases } from "./leases.ts";
import {
  autostopMode,
  checksPassing,
  deleteMachine,
  ensureStarted,
  getMachineById,
  groupGenerations,
  hasPublishedService,
  listMachinesByApp,
  leaseSnapshot,
  ownedReplicas,
  ReplicaNotCreated,
  replicaIndexOf,
  retireMachines,
  sameChecks,
  sameServices,
  sameStopConfig,
  toReplica,
  toReplicaSet,
  waitHealthy,
  type ReconcileReplicasInput,
} from "./replicas.ts";

const metadataOf = (machine: Machine) =>
  Object.fromEntries(
    Object.entries(machine.config?.metadata ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );

const setMetadata = Effect.fn(function* (
  appName: string,
  machine: Machine,
  metadata: Record<string, string>,
  leases: MachineLeases,
) {
  yield* leases.checkTarget(machine.id!);
  // Metadata is not nonce-fenced by Fly; it is recovery evidence, not a lock.
  yield* leases.mutate(
    machine.id!,
    () =>
      machines
        .patchMachineMetadata({
          app_name: appName,
          machine_id: machine.id!,
          metadata,
        })
        .pipe(Effect.timeout("30 seconds")),
    { idempotent: true },
  );
  yield* Effect.sync(() => {
    machine.config = { ...machine.config, metadata };
  });
});

const phase = Effect.fn(function* (
  appName: string,
  machine: Machine,
  value: string,
  leases: MachineLeases,
) {
  if (machine.config?.metadata?.[keys.phase] !== value) {
    yield* setMetadata(
      appName,
      machine,
      {
        ...metadataOf(machine),
        [keys.phase]: value,
      },
      leases,
    );
  }
});

export const setRouting = (
  appName: string,
  machineId: string,
  cordoned: boolean,
  existingLeases?: MachineLeases,
) =>
  usingMachineLeases(appName, existingLeases, (leases) =>
    Effect.gen(function* () {
      yield* leases.acquire([machineId]);
      yield* leases.mutate(
        machineId,
        (lease_nonce) =>
          Effect.gen(function* () {
            const request = {
              app_name: appName,
              machine_id: machineId,
              lease_nonce,
            };
            if (cordoned) yield* machines.cordonMachine(request);
            else yield* machines.uncordonMachine(request);
          }).pipe(Effect.timeout("30 seconds")),
        { idempotent: true },
      );
      yield* getMachineById(appName, machineId).pipe(
        Effect.filterOrFail(
          (machine) => machine !== undefined && machine.cordoned === cordoned,
          () => new ReplicaNotCreated({ appName, name: machineId }),
        ),
        Effect.retry({
          times: 8,
          schedule: Schedule.spaced("500 millis"),
          while: (error) => error._tag === "Fly.ReplicaNotCreated",
        }),
      );
    }),
  );

const pinnedImage = (machine: Machine) => {
  const image = machine.image_ref;
  if (!image?.digest || !image.repository) return undefined;
  return `${image.registry ? `${image.registry}/` : ""}${image.repository}@${image.digest}`;
};

export class DeploymentRecoveryAmbiguous extends Data.TaggedError(
  "Fly.DeploymentRecoveryAmbiguous",
)<{
  appName: string;
  message: string;
}> {}

export const readinessRoles = (
  config: machines.FlyMachineConfig,
  count: number,
  predecessors: Machine[],
): Array<"run" | "idle"> => {
  const services = config.services ?? [];
  if (
    !services.length ||
    services.some((service) => autostopMode(service.autostop) === "off")
  ) {
    return Array.from({ length: count }, () => "run");
  }
  const roles: Array<"run" | "idle"> = Array.from(
    { length: count },
    (_, index) =>
      predecessors.some(
        (machine) =>
          replicaIndexOf(machine) === index && machine.state === "started",
      )
        ? "run"
        : "idle",
  );
  const floor = Math.min(
    count,
    Math.max(
      1,
      ...services.map((service) => service.min_machines_running ?? 0),
    ),
  );
  for (
    let index = 0;
    roles.filter((role) => role === "run").length < floor;
    index++
  )
    roles[index] = "run";
  return roles;
};

const idle = (machine: Machine) =>
  machine.state === "stopped" ||
  machine.state === "suspended" ||
  machine.state === "created";

/** Cloud metadata records preparation and promotion; replica zero commits a complete set. */
export const reconcileBlueGreen = Effect.fn(function* (
  input: ReconcileReplicasInput,
  ownership: Record<string, string>,
  metadata: Record<string, string>,
  leases: MachineLeases,
) {
  const config = input.buildConfig({ index: 0, mounts: [], metadata });
  const containerPins =
    config.containers === undefined ? undefined : pinsFromConfig(config);
  const containerMode = config.containers !== undefined;
  const ambiguous = (message: string) =>
    new DeploymentRecoveryAmbiguous({ appName: input.appName, message });
  if (containerMode && containerPins === undefined)
    return yield* ambiguous(
      "Blue/green requires a complete immutable container image set.",
    );
  const workload = yield* sha256Object({
    config: containerMode
      ? {
          ...config,
          containers: canonicalContainers(config.containers),
        }
      : config,
    count: input.count,
    minSecretsVersion: input.minSecretsVersion,
    // A single region hashes as before, so existing generations stay current.
    region: input.regions.length === 1 ? input.regions[0] : [...input.regions],
  });
  const observe = listMachinesByApp(input.appName).pipe(
    Effect.flatMap((listed) => {
      const owned = ownedReplicas(listed, {
        ...input,
        metadata: ownership,
        machineIds: input.outputMachineIds,
      });
      const changed = listed.find(
        (machine) =>
          machine.id &&
          input.outputMachineIds?.includes(machine.id) &&
          !owned.includes(machine),
      );
      return changed
        ? Effect.fail(
            ambiguous(
              `Cached Machine ${changed.id} no longer has the expected ownership.`,
            ),
          )
        : Effect.succeed(owned);
    }),
  );
  const snapshot = yield* observe;
  const owned = yield* leaseSnapshot(input.appName, snapshot, leases);
  // A vanished snapshot member can have a successor outside this inventory.
  if (
    snapshot.some(
      (machine) => !owned.some((current) => current.id === machine.id),
    )
  ) {
    return yield* ambiguous(
      "Owned Machine membership changed while acquiring leases; retry with a fresh deployment snapshot.",
    );
  }
  for (const machine of owned) {
    const state = classifyDeploymentState(machine);
    if (state.protocol === "invalid")
      return yield* ambiguous(`Machine ${machine.id}: ${state.reason}`);
  }

  const idleAllowed =
    (config.services?.length ?? 0) > 0 &&
    config.services!.every(
      (service) => autostopMode(service.autostop) !== "off",
    );
  const preparationServices = config.services?.map((service) => ({
    ...service,
    autostop: "off",
  }));
  const mismatchOf = (machine: Machine): string | undefined => {
    const observed = metadataOf(machine);
    if (containerMode) {
      if (
        observed[keys.protocol] !== "2" ||
        !validObservedImageSet(machine) ||
        !sameImageSet(pinsFromConfig(machine.config), containerPins)
      )
        return "container image set";
    } else {
      const pinned = observed[keys.image];
      if (pinned === undefined && observed[keys.phase] !== "candidate")
        return "metadata.image";
      if (
        !pinnedImage(machine) ||
        (pinned !== undefined && pinned !== pinnedImage(machine))
      )
        return "image_ref";
    }
    const secretsVersion = Number(observed[keys.secretsVersion] ?? -1);
    if (
      input.minSecretsVersion !== undefined &&
      (!Number.isSafeInteger(secretsVersion) ||
        secretsVersion < input.minSecretsVersion)
    )
      return "metadata.secretsVersion";
    const temporary =
      observed[keys.role] === "run" &&
      observed[keys.restored] === "false" &&
      sameServices(machine.config?.services, preparationServices);
    if (observed[keys.workload] !== workload) return "metadata.workload";
    if (
      input.configDrifted(
        {
          ...machine,
          config: {
            ...machine.config,
            image: config.image,
            services: temporary ? config.services : machine.config?.services,
          },
        },
        {
          mounts: [],
          metadata: {
            ...Object.fromEntries(
              Object.entries(observed).filter(([key]) =>
                key.startsWith("alchemy."),
              ),
            ),
            ...metadata,
          },
        },
      )
    )
      return "config";
    if (!sameChecks(machine.config?.checks, config.checks))
      return "config.checks";
    if (!sameStopConfig(machine.config?.stop_config, config.stop_config))
      return "config.stop_config";
    return undefined;
  };
  const matches = (machine: Machine) => mismatchOf(machine) === undefined;
  const groups = groupGenerations(owned);
  const sequences = new Set<string>();
  for (const [generation, group] of groups) {
    if (generation === undefined) continue;
    const sequence = group[0]?.config?.metadata?.[keys.sequence];
    if (
      !sequence ||
      !Number.isSafeInteger(Number(sequence)) ||
      Number(sequence) < 1 ||
      sequences.has(sequence) ||
      group.some(
        (machine) => machine.config?.metadata?.[keys.sequence] !== sequence,
      ) ||
      (group.some(
        (machine) => machine.config?.metadata?.[keys.protocol] === "2",
      ) &&
        !validProtocol2Generation(group))
    ) {
      return yield* ambiguous(
        "Owned generations have ambiguous sequence/lineage metadata; preserving all capacity.",
      );
    }
    sequences.add(sequence);
  }
  const reusable = [...groups.entries()]
    .filter(
      ([generation, group]) => generation !== undefined && group.every(matches),
    )
    .sort(
      ([, a], [, b]) =>
        Number(b[0]?.config?.metadata?.[keys.sequence] ?? 0) -
        Number(a[0]?.config?.metadata?.[keys.sequence] ?? 0),
    )[0];
  const generation =
    reusable?.[0] ??
    (yield* sha256Object({
      workload,
      predecessors: owned.map((machine) => machine.id).sort(),
    })).slice(0, 20);
  const desired = reusable?.[1] ?? [];
  if (
    new Set(desired.map(replicaIndexOf)).size !== desired.length ||
    desired.some((machine) => replicaIndexOf(machine) >= input.count)
  ) {
    return yield* ambiguous(
      "The recovered generation has duplicate or out-of-range replica indices.",
    );
  }
  const sequence =
    desired[0]?.config?.metadata?.[keys.sequence] ??
    String(
      1 +
        Math.max(
          0,
          ...owned.map((machine) =>
            Number(machine.config?.metadata?.[keys.sequence] ?? 0),
          ),
        ),
    );
  const predecessors = owned.filter(
    (machine) => machine.config?.metadata?.[keys.generation] !== generation,
  );
  const recordedRoles = desired[0]?.config?.metadata?.[keys.roles];
  const roles =
    recordedRoles?.split(",") ??
    readinessRoles(config, input.count, predecessors);
  if (
    roles.length !== input.count ||
    roles.some((role) => role !== "run" && role !== "idle") ||
    !roles.includes("run") ||
    desired.some(
      (machine) =>
        machine.config?.metadata?.[keys.roles] !== recordedRoles ||
        ((machine.config?.metadata?.[keys.protocol] === "1" ||
          machine.config?.metadata?.[keys.protocol] === "2") &&
          machine.config.metadata[keys.role] !==
            roles[replicaIndexOf(machine)]),
    )
  ) {
    return yield* ambiguous(
      "The recovered generation has inconsistent readiness roles.",
    );
  }
  const complete =
    desired.length === input.count &&
    desired.every(
      (machine) =>
        machine.config?.metadata?.[keys.phase] === "active" &&
        machine.config.metadata[keys.restored] === "true" &&
        (roles[replicaIndexOf(machine)] === "idle" ||
          (machine.instance_id !== undefined &&
            machine.config.metadata[keys.checkedInstance] ===
              machine.instance_id)) &&
        machine.cordoned === false,
    );
  if (
    complete &&
    !predecessors.length &&
    desired.every(
      (machine) =>
        machine.state === "started" || (idleAllowed && idle(machine)),
    )
  ) {
    return toReplicaSet(
      [...desired]
        .sort((a, b) => replicaIndexOf(a) - replicaIndexOf(b))
        .map((machine) => toReplica(machine, new Map())),
      input.appName,
      input.baseName,
      config.services,
    );
  }
  const candidates: Machine[] = [];
  const snapshotIds = new Set(owned.map((machine) => machine.id));
  let image = desired[0] ? pinnedImage(desired[0]) : undefined;
  const order = Array.from({ length: input.count }, (_, index) => index).sort(
    (a, b) => Number(roles[b] === "run") - Number(roles[a] === "run") || a - b,
  );
  // Creation-time predecessor IDs are diagnostic lineage, not deletion authority.
  const predecessorIds = predecessors
    .flatMap((machine) => (machine.id ? [machine.id] : []))
    .sort()
    .join(",");
  yield* Effect.gen(function* () {
    for (const index of order) {
      const suffix = `-${generation}-${index}`;
      const name = `${input.baseName.slice(0, 30 - suffix.length).replace(/-+$/g, "")}${suffix}`;
      let current = desired.find(
        (machine) => replicaIndexOf(machine) === index,
      );
      if (current === undefined) {
        const run = roles[index] === "run";
        const candidateConfig = input.buildConfig({
          index,
          mounts: [],
          metadata: {
            ...metadata,
            [keys.replica]: String(index),
            [keys.generation]: generation,
            [keys.workload]: workload,
            [keys.phase]: "candidate",
            [keys.sequence]: sequence,
            [keys.count]: String(input.count),
            [keys.protocol]: containerMode ? "2" : "1",
            [keys.roles]: roles.join(","),
            [keys.role]: roles[index]!,
            [keys.predecessors]: predecessorIds,
            [keys.restored]: String(
              !run || sameServices(config.services, preparationServices),
            ),
            ...(input.minSecretsVersion === undefined
              ? {}
              : { [keys.secretsVersion]: String(input.minSecretsVersion) }),
            ...(containerPins
              ? { [keys.containerImageSet]: encodeImageSet(containerPins)! }
              : image
                ? { [keys.image]: image }
                : {}),
          },
        });
        const pinnedConfig = containerPins
          ? applyImageSet(candidateConfig, containerPins)
          : candidateConfig;
        if (pinnedConfig === undefined)
          return yield* ambiguous("Incomplete candidate image set.");
        const readback = observe.pipe(
          Effect.map((listed) =>
            listed.find(
              (machine) =>
                machine.name === name &&
                machine.config?.metadata?.[keys.generation] === generation &&
                replicaIndexOf(machine) === index &&
                matches(machine),
            ),
          ),
          Effect.filterOrFail(
            (machine) => machine !== undefined,
            () => new ReplicaNotCreated({ appName: input.appName, name }),
          ),
          Effect.retry({
            times: 8,
            schedule: Schedule.spaced("500 millis"),
            while: (error) => error._tag === "Fly.ReplicaNotCreated",
          }),
        );
        current = yield* machines
          .createMachine({
            app_name: input.appName,
            name,
            region: regionOfReplica(input.regions, index),
            config: {
              ...pinnedConfig,
              image: containerPins ? undefined : (image ?? config.image),
              services: run ? preparationServices : config.services,
            },
            skip_launch: !run,
            skip_service_registration: true,
            min_secrets_version: input.minSecretsVersion,
          })
          .pipe(
            Retry.none,
            Effect.timeout("30 seconds"),
            Effect.catchTag(
              ["Conflict", "GatewayTimeout", "TimeoutError"],
              () => readback,
            ),
            Effect.catchTag("HttpClientError", (error) =>
              error.reason._tag === "TransportError"
                ? readback
                : Effect.fail(error),
            ),
          );
      }
      if (!current?.id)
        return yield* new ReplicaNotCreated({ appName: input.appName, name });
      const leased = (yield* leaseSnapshot(
        input.appName,
        [current],
        leases,
      ))[0];
      if (!leased?.id)
        return yield* ambiguous(
          `Candidate ${current.id} disappeared before its lease was acquired.`,
        );
      const mismatch = mismatchOf(leased);
      if (mismatch !== undefined)
        return yield* ambiguous(
          `Candidate ${current.id} changed before its lease was acquired. Mismatch: ${mismatch}.`,
        );
      current = leased;
      snapshotIds.add(current.id);
      if (containerPins) {
        if (
          !validObservedImageSet(current) ||
          !sameImageSet(pinsFromConfig(current.config), containerPins)
        )
          return yield* ambiguous(
            `Container image pin mismatch on ${current.id}.`,
          );
      } else {
        const resolvedImage = pinnedImage(current);
        if (!resolvedImage || (image !== undefined && image !== resolvedImage))
          return yield* ambiguous(`Image pin mismatch on ${current.id}.`);
        image = resolvedImage;
        if (current.config?.metadata?.[keys.image] !== image)
          yield* setMetadata(
            input.appName,
            current,
            {
              ...metadataOf(current),
              [keys.image]: image,
            },
            leases,
          );
      }
      const checked =
        current.config?.metadata?.[keys.checkedInstance] ===
          current.instance_id && current.instance_id !== undefined;
      if (
        roles[index] === "run" &&
        !(idleAllowed && checked && idle(current))
      ) {
        current = yield* ensureStarted(
          input.appName,
          current,
          false,
          input.policy.healthTimeoutMs,
          current.config,
          leases,
        );
      } else if (!idle(current)) {
        current = yield* waitHealthy(
          input.appName,
          current,
          input.policy.healthTimeoutMs,
          current.config,
        );
      }
      candidates[index] = current;
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const found = (yield* observe).filter(
          (machine) =>
            snapshotIds.has(machine.id) &&
            machine.config?.metadata?.[keys.generation] === generation,
        );
        // A possibly promoted candidate is capacity, not rollback garbage.
        if (
          found.every(
            (machine) =>
              (!containerMode || matches(machine)) &&
              machine.config?.metadata?.[keys.phase] === "candidate" &&
              machine.cordoned === true,
          )
        ) {
          yield* Effect.forEach(
            found,
            (machine) =>
              deleteMachine(input.appName, machine.id!, leases).pipe(
                Effect.catch((cleanup) =>
                  Effect.logWarning("Fly candidate cleanup remains pending", {
                    appName: input.appName,
                    machineId: machine.id,
                    error: cleanup._tag,
                  }),
                ),
              ),
            { concurrency: 4 },
          );
        }
        return yield* Effect.fail(error);
      }),
    ),
  );

  const needsPromotion = candidates.some(
    (machine) =>
      machine.cordoned !== false ||
      machine.config?.metadata?.[keys.phase] !== "active",
  );
  if (needsPromotion) {
    for (const machine of candidates)
      yield* phase(input.appName, machine, "promoting", leases);
    // Promotion metadata resets reports; validate the whole set before routing any member.
    for (const [index, machine] of candidates.entries()) {
      const current = yield* getMachineById(input.appName, machine.id!);
      if (!current || !matches(current))
        return yield* ambiguous(
          `Candidate ${machine.id} changed before promotion.`,
        );
      if (current.state === "started") {
        candidates[index] = yield* waitHealthy(
          input.appName,
          current,
          input.policy.healthTimeoutMs,
          current.config,
        );
      } else if (
        !idleAllowed ||
        !idle(current) ||
        (roles[index] === "run" &&
          (current.instance_id === undefined ||
            current.config?.metadata?.[keys.checkedInstance] !==
              current.instance_id))
      ) {
        return yield* ambiguous(
          `Candidate ${machine.id} has no readiness proof before promotion.`,
        );
      } else candidates[index] = current;
    }
    for (const machine of candidates)
      if (machine.cordoned !== false)
        yield* setRouting(input.appName, machine.id!, false, leases);
    if (hasPublishedService(config.services)) yield* Effect.sleep("10 seconds");
  }
  for (const [index, machine] of candidates.entries()) {
    let current = machine;
    if (current.config?.metadata?.[keys.restored] === "false") {
      // Restoring services creates a new instance; its predecessor's checks cannot prove readiness.
      const machineId = current.id!;
      const currentVersion = current.instance_id;
      const restoreConfig = input.buildConfig({
        index,
        mounts: [],
        metadata: { ...metadataOf(current), [keys.restored]: "true" },
      });
      const restored = containerPins
        ? applyImageSet(restoreConfig, containerPins)
        : { ...restoreConfig, image };
      if (restored === undefined)
        return yield* ambiguous(
          "Incomplete image set during service restoration.",
        );
      current = yield* leases.mutate(machineId, (lease_nonce) =>
        machines
          .updateMachine({
            app_name: input.appName,
            machine_id: machineId,
            lease_nonce,
            current_version: currentVersion,
            config: restored,
            min_secrets_version: input.minSecretsVersion,
          })
          .pipe(Effect.timeout("30 seconds")),
      );
      current = yield* ensureStarted(
        input.appName,
        current,
        false,
        input.policy.healthTimeoutMs,
        config,
        leases,
      );
    } else {
      current = (yield* getMachineById(input.appName, current.id!)) ?? current;
      if (current.instance_id !== machine.instance_id) {
        current = yield* ensureStarted(
          input.appName,
          current,
          false,
          input.policy.healthTimeoutMs,
          config,
          leases,
        );
      }
      if (
        current.state !== "started" &&
        roles[index] === "run" &&
        current.config?.metadata?.[keys.checkedInstance] !== current.instance_id
      ) {
        current = yield* ensureStarted(
          input.appName,
          current,
          false,
          input.policy.healthTimeoutMs,
          config,
          leases,
        );
      }
    }
    candidates[index] = current;
  }
  // Reset reports while still pending; an interrupted validation is not a commit.
  for (const machine of candidates)
    yield* phase(input.appName, machine, "validating", leases);
  for (const [index, machine] of candidates.entries()) {
    const current = yield* getMachineById(input.appName, machine.id!);
    if (
      !current ||
      !matches(current) ||
      current.config?.metadata?.[keys.restored] !== "true"
    )
      return yield* ambiguous(
        `Candidate ${machine.id} changed before commitment.`,
      );
    if (current.state === "started")
      candidates[index] = yield* waitHealthy(
        input.appName,
        current,
        input.policy.healthTimeoutMs,
        config,
      );
    else if (
      !idleAllowed ||
      !idle(current) ||
      (roles[index] === "run" &&
        (current.instance_id === undefined ||
          (current.config?.metadata?.[keys.checkedInstance] !==
            current.instance_id &&
            !(
              machine.instance_id === current.instance_id &&
              checksPassing(machine, config)
            ))))
    ) {
      return yield* ambiguous(
        `Candidate ${machine.id} has no readiness proof for its current instance.`,
      );
    } else candidates[index] = current;
  }
  // All final checks precede the commit stamps, with replica zero last.
  for (const machine of [...candidates].reverse()) {
    const committed = {
      ...metadataOf(machine),
      [keys.phase]: "active",
      ...(machine.state === "started" ||
      roles[replicaIndexOf(machine)] === "run"
        ? { [keys.checkedInstance]: machine.instance_id! }
        : {}),
    };
    if (!deepEqual(metadataOf(machine), committed))
      yield* setMetadata(input.appName, machine, committed, leases);
  }
  // Legacy ownership is required; predecessor phase stamps are only advisory.
  for (const machine of predecessors) {
    if (machine.config?.metadata?.[keys.protocol] === "2") {
      const observed = yield* getMachineById(input.appName, machine.id!);
      if (
        !observed ||
        observed.config?.metadata?.[keys.protocol] !== "2" ||
        !validObservedImageSet(observed) ||
        !sameImageSet(
          pinsFromConfig(observed.config),
          pinsFromConfig(machine.config),
        )
      )
        return yield* ambiguous(
          `Predecessor ${machine.id} image identity changed before retirement.`,
        );
    }
    if (machine.config?.metadata?.[keys.instance] === undefined)
      yield* setMetadata(
        input.appName,
        machine,
        {
          ...metadataOf(machine),
          ...metadata,
        },
        leases,
      );
    if (machine.host_status !== "unreachable")
      yield* phase(input.appName, machine, "retiring", leases).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Fly predecessor phase metadata was not updated", {
            appName: input.appName,
            machineId: machine.id,
            error: error._tag,
          }),
        ),
      );
  }
  yield* retireMachines(input.appName, predecessors, true, leases);
  return toReplicaSet(
    candidates.map((machine) => toReplica(machine, new Map())),
    input.appName,
    input.baseName,
    config.services,
  );
});
