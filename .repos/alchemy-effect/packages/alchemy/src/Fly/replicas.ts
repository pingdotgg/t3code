import type {
  FlyMachineConfig,
  FlyMachineMount,
  FlyMachineService,
  FlyMachineServiceCheck,
  FlyStopConfig,
  ImageRef as FlyImageRef,
  Machine as FlyMachine,
  Volume as FlyVolume,
} from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Result from "effect/Result";
import { deepEqual } from "../Diff.ts";
import {
  validateDeployment,
  type DeploymentPolicy,
  type MachineCheck,
} from "./Deployment.ts";
import { reconcileBlueGreen, setRouting } from "./bluegreen.ts";
import {
  classifyDeploymentState,
  validProtocol2Generation,
} from "./DeploymentState.ts";
import { usingMachineLeases, type MachineLeases } from "./leases.ts";
import { regionOfReplica } from "./Region.ts";
import { listOwnedApps } from "./App.ts";
import type {
  MachineGuest,
  MachineImageRef,
  MachineService,
  MachineServiceCheck,
} from "./Machine.ts";
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
const SERVICE_CHECK_NAME_PREFIX = "servicecheck-";

export class ReplicaNotCreated extends Data.TaggedError(
  "Fly.ReplicaNotCreated",
)<{
  name: string;
  appName: string;
}> {}

export class ReplicaChecksNotPassing extends Data.TaggedError(
  "Fly.ReplicaChecksNotPassing",
)<{
  appName: string;
  machineId: string;
  checks: ReadonlyArray<{
    name: string | undefined;
    status: string | undefined;
    output: string | undefined;
  }>;
}> {
  get message() {
    const checks = this.checks.map(
      (check) =>
        `${check.name ?? "unnamed"}: ${check.status ?? "unknown"}${check.output ? ` (${check.output})` : ""}`,
    );
    return `Service checks did not pass for ${this.appName}/${this.machineId}: ${checks.join("; ") || "no service check results"}`;
  }
}

export interface Replica {
  machineId: string;
  name: string;
  baseName?: string;
  region: string;
  state: string;
  instanceId: string | undefined;
  privateIp: string | undefined;
  imageRef: MachineImageRef | undefined;
  guest: MachineGuest | undefined;
  mounts: MountedDisk[];
}

export interface ReplicaSet {
  rolloutPending?: boolean;
  appName: string;
  machineId: string;
  machineIds: string[];
  name: string;
  baseName?: string;
  /** Region of replica 0. */
  region: string;
  /** Regions the replicas run in, in replica order. */
  regions: string[];
  state: string;
  instanceId: string | undefined;
  privateIp: string | undefined;
  imageRef: MachineImageRef | undefined;
  guest: MachineGuest | undefined;
  /** Observed proxy services published by replica 0. */
  services: FlyMachineService[] | undefined;
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
    Effect.catchTag("NotFound", () => Effect.succeed([])),
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

export const toFlyServiceCheck = (
  check: MachineServiceCheck,
): FlyMachineServiceCheck => ({
  type: check.type,
  port: check.port,
  interval: check.interval,
  timeout: check.timeout,
  grace_period: check.gracePeriod,
  method: check.method,
  path: check.path,
  protocol: check.protocol,
  headers: check.headers?.map((header) => ({
    name: header.name,
    values: header.values,
  })),
  tls_server_name: check.tlsServerName,
  tls_skip_verify: check.tlsSkipVerify,
});

export const toFlyService = (service: MachineService): FlyMachineService => ({
  protocol: service.protocol,
  internal_port: service.internalPort,
  autostart: service.autostart,
  autostop:
    typeof service.autostop === "boolean"
      ? service.autostop
        ? "stop"
        : "off"
      : service.autostop,
  min_machines_running: service.minMachinesRunning,
  ports: service.ports?.map((port) => ({
    port: port.port,
    handlers: port.handlers,
    force_https: port.forceHttps,
    start_port: port.startPort,
    end_port: port.endPort,
  })),
  checks: service.checks?.map((check) => ({
    ...toFlyServiceCheck(check),
    // Fly clamps service-check intervals; named Machine checks retain longer intervals.
    interval:
      (durationNanoseconds(check.interval) ?? 0n) > 60_000_000_000n
        ? "60s"
        : check.interval,
  })),
});

export const autostopMode = (value: string | boolean | undefined) =>
  value === true
    ? "stop"
    : value === false || value === undefined
      ? "off"
      : value;

const normalizedCheckDuration = (value: string | undefined) => {
  const nanos = durationNanoseconds(value);
  return nanos === undefined ? value : `${nanos}ns`;
};

const normalizedCheck = (
  check: machines.FlyMachineCheck | FlyMachineServiceCheck | undefined,
) =>
  check === undefined
    ? undefined
    : {
        ...check,
        grace_period: normalizedCheckDuration(check.grace_period),
        interval: normalizedCheckDuration(check.interval),
        timeout: normalizedCheckDuration(check.timeout),
      };

export const sameChecks = (
  observed: FlyMachineConfig["checks"],
  desired: FlyMachineConfig["checks"],
) => {
  const normalize = (checks: FlyMachineConfig["checks"]) =>
    Object.fromEntries(
      Object.entries(checks ?? {}).map(([name, check]) => [
        name,
        normalizedCheck(check),
      ]),
    );
  return deepEqual(normalize(observed), normalize(desired), {
    stripNullish: true,
  });
};

export const normalizedServices = (services: FlyMachineService[] | undefined) =>
  (services ?? []).map((service) => ({
    ...service,
    autostop: autostopMode(service.autostop),
    checks: service.checks?.map(normalizedCheck),
  }));

export const sameServices = (
  observed: FlyMachineService[] | undefined,
  desired: FlyMachineService[] | undefined,
) =>
  deepEqual(normalizedServices(observed), normalizedServices(desired), {
    stripNullish: true,
  });

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
      Retry.none,
      Effect.retry({
        times: 6,
        schedule: waitBackoff,
        while: (e) =>
          e._tag === "GatewayTimeout" || e._tag === "MachineWaitTimeout",
      }),
      Effect.timeout("50 seconds"),
    );

export const configuredCheckNames = (config: FlyMachineConfig | undefined) => [
  ...Object.keys(config?.checks ?? {}),
  ...(config?.services ?? []).flatMap((service) =>
    (service.checks ?? []).map(
      (check, checkIndex) =>
        `${SERVICE_CHECK_NAME_PREFIX}${String(checkIndex).padStart(2, "0")}-${check.type ?? "tcp"}-${service.internal_port}`,
    ),
  ),
];

export const checksPassing = (
  machine: FlyMachine,
  config: FlyMachineConfig | undefined,
) => {
  const expected = configuredCheckNames(config);
  const checks = machine.checks ?? [];
  // Fly may also report compatibility mirrors; they do not replace service reports.
  return (
    machine.state === "started" &&
    new Set(expected).size === expected.length &&
    checks.every(
      (check) =>
        check.name !== undefined &&
        check.status === "passing" &&
        (expected.includes(check.name) ||
          expected.some(
            (name) =>
              name.startsWith(SERVICE_CHECK_NAME_PREFIX) &&
              check.name ===
                name.replace(
                  SERVICE_CHECK_NAME_PREFIX,
                  "bg_deployments_compat-",
                ),
          )),
    ) &&
    new Set(checks.map((check) => check.name)).size === checks.length &&
    expected.every((name) => {
      const reports = checks.filter((check) => check.name === name);
      return reports.length === 1 && reports[0]?.status === "passing";
    })
  );
};

const TRANSIENT_GET_TAGS = [
  "TooManyRequests",
  "InternalServerError",
  "BadGateway",
  "ServiceUnavailable",
  "GatewayTimeout",
] as const;

/**
 * After the Machine is started, wait until Fly reports every service
 * check as passing. No configured checks is a no-op. Empty live
 * `servicecheck-*` results keep polling — they are not success.
 * `warning` / `unknown` during grace keep polling.
 */
export const waitHealthy = Effect.fn(function* (
  appName: string,
  machine: FlyMachine,
  healthTimeoutMs = 60_000,
  config: FlyMachineConfig | undefined = machine.config,
) {
  const machineId = machine.id;
  const named = Object.keys(config?.checks ?? {});
  const expected = (config?.services ?? []).flatMap(
    (service) => service.checks ?? [],
  ).length;
  if (machineId === undefined || (expected === 0 && named.length === 0))
    return machine;

  let observed = machine;
  const notPassing = () =>
    new ReplicaChecksNotPassing({
      appName,
      machineId,
      checks: (observed.checks ?? []).map((check) => ({
        name: check.name,
        status: check.status,
        output: undefined,
      })),
    });
  const passing = yield* getMachineById(appName, machineId).pipe(
    Retry.none,
    Effect.map((current) => {
      if (current === undefined) return false;
      observed = current;
      return (
        current.instance_id !== undefined &&
        current.instance_id === machine.instance_id &&
        checksPassing(current, config)
      );
    }),
    Effect.catchTag(TRANSIENT_GET_TAGS, () => Effect.succeed(false)),
    Effect.catchTag("HttpClientError", (error) =>
      error.reason._tag === "TransportError"
        ? Effect.succeed(false)
        : Effect.fail(error),
    ),
    Effect.repeat({
      schedule: Schedule.spaced(healthTimeoutMs / 10),
      until: (passing) => passing,
      times: 10,
    }),
    Effect.timeoutOrElse({
      duration: healthTimeoutMs,
      orElse: () => Effect.fail(notPassing()),
    }),
  );
  if (!passing) return yield* notPassing();
  return observed;
});

export const waitDestroyed = (appName: string, machineId: string) =>
  machines
    .waitMachine({
      app_name: appName,
      machine_id: machineId,
      state: "destroyed",
      timeout: WAIT_TIMEOUT_SECONDS,
    })
    .pipe(
      Retry.none,
      Effect.as(undefined),
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.retry({
        times: 6,
        schedule: waitBackoff,
        while: (e) =>
          e._tag === "GatewayTimeout" || e._tag === "MachineWaitTimeout",
      }),
      Effect.timeout("50 seconds"),
    );

export const ensureStarted = (
  appName: string,
  machine: FlyMachine,
  skipLaunch: boolean,
  healthTimeoutMs = 60_000,
  expectedConfig?: FlyMachineConfig,
  existingLeases?: MachineLeases,
) =>
  usingMachineLeases(appName, existingLeases, (leases) =>
    ensureLeasedStarted(
      appName,
      machine,
      skipLaunch,
      healthTimeoutMs,
      expectedConfig,
      leases,
    ),
  );

const ensureLeasedStarted = Effect.fn(function* (
  appName: string,
  machine: FlyMachine,
  skipLaunch: boolean,
  healthTimeoutMs: number,
  expectedConfig: FlyMachineConfig | undefined,
  leases: MachineLeases,
) {
  const machineId = machine.id;
  if (machineId === undefined || skipLaunch) return machine;
  yield* leases.acquire([machineId]);
  const started = yield* Effect.gen(function* () {
    // Create/update responses can lag Fly's automatic launch.
    const current = yield* machines.getMachine({
      app_name: appName,
      machine_id: machineId,
    });
    if (!sameOwnership(current, machine)) {
      return yield* new ReplicaOwnershipChanged({ appName, machineId });
    }
    yield* Effect.logDebug("Fly machine startup", {
      appName,
      machineId,
      state: current.state,
    });
    if (
      current.state === "stopped" ||
      current.state === "suspended" ||
      current.state === "failed"
    ) {
      yield* leases.mutate(machineId, (lease_nonce) =>
        machines.startMachine({
          app_name: appName,
          machine_id: machineId,
          lease_nonce,
        }),
      );
    }
    // Re-observe state between waits instead of retrying the wait in the SDK.
    yield* machines
      .waitMachine({
        app_name: appName,
        machine_id: machineId,
        state: "started",
        instance_id: current.instance_id,
        timeout: WAIT_TIMEOUT_SECONDS,
      })
      .pipe(Retry.none);
    return yield* machines.getMachine({
      app_name: appName,
      machine_id: machineId,
    });
  }).pipe(
    Effect.retry({
      times: 6,
      schedule: waitBackoff,
      while: (error) =>
        error._tag === "MachineStartFromCreatedState" ||
        error._tag === "MachineReplacing" ||
        error._tag === "MachineWaitTimeout" ||
        error._tag === "Conflict" ||
        error._tag === "GatewayTimeout",
    }),
    Effect.timeout("180 seconds"),
  );
  return yield* waitHealthy(
    appName,
    started,
    healthTimeoutMs,
    expectedConfig ?? machine.config,
  );
});

export const deleteMachine = (
  appName: string,
  machineId: string,
  existingLeases?: MachineLeases,
) =>
  usingMachineLeases(appName, existingLeases, (leases) =>
    Effect.gen(function* () {
      if (appName.length === 0 || machineId.length === 0) return;
      yield* leases.acquire([machineId]);
      yield* leases.remove(machineId, (lease_nonce) =>
        machines
          .deleteMachine({
            app_name: appName,
            machine_id: machineId,
            force: true,
            lease_nonce,
          })
          .pipe(Effect.timeout("30 seconds")),
      );
      yield* waitDestroyed(appName, machineId);
    }).pipe(Effect.catchTag("NotFound", () => leases.forget(machineId))),
  );

const durationNanoseconds = (value: string | undefined) => {
  if (value === undefined || value === "") return undefined;
  const negative = value.startsWith("-");
  const duration = /^[+-]/.test(value) ? value.slice(1) : value;
  if (duration === "0") return 0n;
  const limit = negative ? 1n << 63n : (1n << 63n) - 1n;
  const units: Record<string, bigint> = {
    ns: 1n,
    us: 1_000n,
    µs: 1_000n,
    μs: 1_000n,
    ms: 1_000_000n,
    s: 1_000_000_000n,
    m: 60_000_000_000n,
    h: 3_600_000_000_000n,
  };
  let total = 0n;
  let consumed = 0;
  for (const part of duration.matchAll(
    /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gy,
  )) {
    const [integer = "", fraction = ""] = part[1]!.split(".");
    const whole = integer.replace(/^0+/, "") || "0";
    if (whole.length > 19) return undefined;
    const unit = units[part[2]!]!;
    let fractionalNanos = 0n;
    // Truncate each component to nanoseconds without unbounded BigInt operands.
    for (let index = fraction.length - 1; index >= 0; index--) {
      fractionalNanos =
        (BigInt(fraction[index]!) * unit + fractionalNanos) / 10n;
    }
    total += BigInt(whole) * unit + fractionalNanos;
    if (total > limit) return undefined;
    consumed += part[0].length;
  }
  if (consumed === 0 || consumed !== duration.length) return undefined;
  return negative ? -total : total;
};

const stopTimeoutMillis = (timeout: string | undefined) => {
  if (timeout === "") return 0;
  // Shutdown policies retain their unsigned millisecond-or-larger syntax.
  if (
    timeout === undefined ||
    !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(timeout)
  ) {
    return undefined;
  }
  const nanos = durationNanoseconds(timeout);
  return nanos === undefined ? undefined : Number(nanos) / 1_000_000;
};

export const sameStopConfig = (
  observed: FlyStopConfig | undefined,
  desired: FlyStopConfig | undefined,
) =>
  observed?.signal === desired?.signal &&
  stopTimeoutMillis(observed?.timeout) === stopTimeoutMillis(desired?.timeout);

export class ShutdownPolicyMismatch extends Data.TaggedError(
  "Fly.ShutdownPolicyMismatch",
)<{ machineId: string; message: string }> {}

export const predecessorShutdown = Effect.fn(function* (machine: FlyMachine) {
  const persisted = machine.config?.stop_config;
  const injected = machine.config?.env?.ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS;
  const timeoutMs = stopTimeoutMillis(persisted?.timeout);
  if (injected !== undefined) {
    const managedTimeout = Number(injected);
    const signal = persisted?.signal ?? "SIGTERM";
    if (
      !/^\d+$/.test(injected) ||
      !Number.isSafeInteger(managedTimeout) ||
      managedTimeout <= 0 ||
      managedTimeout > 300_000 ||
      (signal !== "SIGTERM" && signal !== "SIGINT") ||
      (persisted?.timeout !== undefined && timeoutMs !== managedTimeout)
    ) {
      return yield* new ShutdownPolicyMismatch({
        machineId: machine.id ?? "",
        message:
          "The predecessor's managed shutdown environment and stop_config disagree; reconcile its shutdown policy before migration.",
      });
    }
    return {
      signal,
      timeout: persisted?.timeout ?? `${managedTimeout}ms`,
      timeoutMs: managedTimeout,
    };
  }
  if (persisted?.timeout !== undefined && (!timeoutMs || timeoutMs > 300_000)) {
    return yield* new ShutdownPolicyMismatch({
      machineId: machine.id ?? "",
      message:
        "The predecessor has an invalid stop_config timeout; refusing to shorten its shutdown window.",
    });
  }
  // Unspecified raw-image overrides must remain unspecified for Fly's defaults.
  return {
    signal: persisted?.signal,
    timeout: persisted?.timeout,
    timeoutMs: timeoutMs ?? 300_000,
  };
});

export class ReplicaOwnershipChanged extends Data.TaggedError(
  "Fly.ReplicaOwnershipChanged",
)<{
  appName: string;
  machineId: string;
}> {}

export class ReplicaRetirementIncomplete extends Data.TaggedError(
  "Fly.ReplicaRetirementIncomplete",
)<{
  appName: string;
  residuals: Array<{ machineId: string; stage: string }>;
}> {}

const retirementStep =
  (appName: string, machineId: string, stage: string) =>
  <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error._tag === "NotFound"
          ? error
          : new ReplicaRetirementIncomplete({
              appName,
              residuals: [{ machineId, stage: `${stage}: ${error._tag}` }],
            }),
      ),
    );

const sameOwnership = (observed: FlyMachine, snapshot: FlyMachine) =>
  observed.id === snapshot.id &&
  [
    alchemyMetadataKeys.stack,
    alchemyMetadataKeys.stage,
    alchemyMetadataKeys.id,
    alchemyMetadataKeys.type,
    alchemyMetadataKeys.instance,
    alchemyMetadataKeys.fqn,
    alchemyMetadataKeys.generation,
  ].every(
    (key) =>
      observed.config?.metadata?.[key] === snapshot.config?.metadata?.[key],
  );

export const leaseSnapshot = Effect.fn(function* (
  appName: string,
  snapshot: FlyMachine[],
  leases: MachineLeases,
) {
  const ordered = [...snapshot].sort((a, b) =>
    (a.id ?? "").localeCompare(b.id ?? ""),
  );
  yield* Effect.forEach(
    ordered,
    (machine) =>
      Effect.gen(function* () {
        if (!machine.id || machine.host_status === "unreachable") return;
        yield* leases
          .acquire([machine.id])
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    { concurrency: 1 },
  ).pipe(Effect.timeout("30 seconds"));
  const observed: FlyMachine[] = [];
  for (const machine of ordered) {
    if (!machine.id) continue;
    if (machine.host_status === "unreachable") {
      observed.push(machine);
      continue;
    }
    const current = yield* getMachineById(appName, machine.id);
    if (!current) {
      yield* leases.forget(machine.id);
      continue;
    }
    if (!sameOwnership(current, machine))
      return yield* new ReplicaOwnershipChanged({
        appName,
        machineId: machine.id,
      });
    yield* leases.checkTarget(machine.id);
    observed.push(current);
  }
  yield* leases.check;
  return observed;
});

export const retireMachines = (
  appName: string,
  snapshot: FlyMachine[],
  replacementReady = false,
  existingLeases?: MachineLeases,
) =>
  usingMachineLeases(appName, existingLeases, (leases) =>
    retireLeasedMachines(appName, snapshot, replacementReady, leases),
  );

const retireLeasedMachines = Effect.fn(function* (
  appName: string,
  snapshot: FlyMachine[],
  replacementReady: boolean,
  leases: MachineLeases,
) {
  const targets = yield* leaseSnapshot(appName, snapshot, leases);
  const results = yield* Effect.forEach(
    targets,
    (machine) =>
      Effect.gen(function* () {
        yield* leases.check;
        const result = yield* Effect.gen(function* () {
          if (!machine.id) return;
          if (replacementReady && machine.host_status === "unreachable") {
            const metadata = machine.config?.metadata;
            if (
              !machine.config ||
              machine.incomplete_config ||
              (machine.config.mounts?.length ?? 0) > 0 ||
              !metadata?.[alchemyMetadataKeys.instance] ||
              !metadata[alchemyMetadataKeys.fqn]
            ) {
              return yield* new ReplicaOwnershipChanged({
                appName,
                machineId: machine.id,
              });
            }
            yield* Effect.logWarning(
              "Force-retiring owned stateless Fly Machine on unreachable host; work was not proven drained",
              { appName, machineId: machine.id },
            );
            const machineId = machine.id;
            const heldNonce = yield* leases.nonceIfHeld(machineId);
            yield* Effect.gen(function* () {
              const remove = (lease_nonce?: string) =>
                machines
                  .deleteMachine({
                    app_name: appName,
                    machine_id: machineId,
                    force: true,
                    lease_nonce,
                  })
                  .pipe(Retry.none, Effect.timeout("30 seconds"));
              if (heldNonce !== undefined)
                yield* leases.remove(machineId, remove);
              else yield* leases.guard(remove());
            }).pipe(
              Effect.catchTag("NotFound", () => Effect.void),
              retirementStep(appName, machineId, "unreachable force-delete"),
            );
            yield* leases.forget(machine.id);
            return yield* waitDestroyed(appName, machine.id);
          }
          yield* retireMachine(appName, machine.id, machine, leases);
        }).pipe(Effect.result);
        yield* leases.check;
        return Result.isFailure(result)
          ? result.failure._tag === "Fly.ReplicaRetirementIncomplete"
            ? result.failure.residuals
            : [{ machineId: machine.id ?? "", stage: result.failure._tag }]
          : [];
      }),
    { concurrency: 4 },
  );
  const residuals = results.flat();
  if (residuals.length)
    return yield* new ReplicaRetirementIncomplete({ appName, residuals });
});

export const retireMachine = (
  appName: string,
  machineId: string,
  snapshot?: FlyMachine,
  existingLeases?: MachineLeases,
) =>
  usingMachineLeases(appName, existingLeases, (leases) =>
    retireLeasedMachine(appName, machineId, snapshot, leases).pipe(
      Effect.tap(() => leases.forget(machineId)),
    ),
  );

const retireLeasedMachine = Effect.fn(
  function* (
    appName: string,
    machineId: string,
    snapshot: FlyMachine | undefined,
    leases: MachineLeases,
  ) {
    yield* leases.acquire([machineId]);
    const current = yield* getMachineById(appName, machineId);
    if (current === undefined) return;
    if (snapshot && !sameOwnership(current, snapshot)) {
      return yield* new ReplicaOwnershipChanged({ appName, machineId });
    }
    const stop = yield* predecessorShutdown(current);
    if (
      current.cordoned === true &&
      current.config?.metadata?.[alchemyMetadataKeys.phase] === "candidate"
    )
      return yield* deleteMachine(appName, machineId, leases);
    if (current.state !== "stopped" && current.state !== "created") {
      yield* leases
        .mutate(
          machineId,
          (lease_nonce) =>
            machines
              .cordonMachine({
                app_name: appName,
                machine_id: machineId,
                lease_nonce,
              })
              .pipe(Effect.timeout("30 seconds")),
          { idempotent: true },
        )
        .pipe(retirementStep(appName, machineId, "cordon"));
      if (hasPublishedService(current.config?.services))
        yield* Effect.sleep("10 seconds");
      yield* leases
        .mutate(
          machineId,
          (lease_nonce) =>
            machines
              .stopMachine({
                app_name: appName,
                machine_id: machineId,
                lease_nonce,
                signal: stop.signal,
                timeout: stop.timeout,
              })
              .pipe(Effect.timeout(stop.timeoutMs + 15_000)),
          { timeoutMs: stop.timeoutMs + 120_000 },
        )
        .pipe(retirementStep(appName, machineId, "stop"));
      yield* machines
        .waitMachine({
          app_name: appName,
          machine_id: machineId,
          state: "stopped",
          instance_id: current.instance_id,
          timeout: WAIT_TIMEOUT_SECONDS,
        })
        .pipe(
          Retry.none,
          Effect.retry({
            times: 10,
            schedule: Schedule.spaced(Math.max(500, stop.timeoutMs / 10)),
            while: (error) =>
              error._tag === "MachineWaitTimeout" ||
              error._tag === "GatewayTimeout",
          }),
          Effect.timeout(stop.timeoutMs + 15_000),
          retirementStep(appName, machineId, "wait-stopped"),
        );
    }
    yield* leases
      .remove(machineId, (lease_nonce) =>
        machines
          .deleteMachine({
            app_name: appName,
            machine_id: machineId,
            force: false,
            lease_nonce,
          })
          .pipe(Effect.timeout("30 seconds")),
      )
      .pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        retirementStep(appName, machineId, "delete"),
      );
    yield* waitDestroyed(appName, machineId).pipe(
      retirementStep(appName, machineId, "verify-absent"),
    );
  },
  Effect.catchTag("NotFound", () => Effect.void),
);

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
    baseName,
    region: primary?.region ?? "",
    regions: [
      ...new Set(
        replicas
          .map((replica) => replica.region)
          .filter((region) => region.length > 0),
      ),
    ],
    state: primary?.state ?? "",
    instanceId: primary?.instanceId,
    privateIp: primary?.privateIp,
    imageRef: primary?.imageRef,
    guest: primary?.guest,
    services,
    count: replicas.length,
    mounts: primary?.mounts ?? [],
    replicas,
  };
};

export const ownedReplicas = (
  listed: FlyMachine[],
  input: {
    metadata: Record<string, string>;
    resourceInstanceId: string;
    fqn: string;
    baseName?: string;
    machineIds?: readonly string[];
  },
) =>
  listed.filter((machine) => {
    const metadata = machine.config?.metadata ?? {};
    if (
      !Object.entries(input.metadata).every(
        ([key, value]) => metadata[key] === value,
      )
    )
      return false;
    if (metadata[alchemyMetadataKeys.instance] !== undefined) {
      return (
        metadata[alchemyMetadataKeys.instance] === input.resourceInstanceId &&
        metadata[alchemyMetadataKeys.fqn] === input.fqn
      );
    }
    return (
      (machine.id !== undefined && input.machineIds?.includes(machine.id)) ||
      (input.baseName !== undefined &&
        (machine.name === input.baseName ||
          machine.name ===
            replicaMachineName(input.baseName, replicaIndexOf(machine), 2)))
    );
  });

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
            const metadata = machine.config?.metadata;
            const key = JSON.stringify([
              metadata?.[alchemyMetadataKeys.stack],
              metadata?.[alchemyMetadataKeys.stage],
              metadata?.[alchemyMetadataKeys.fqn] ?? id,
              metadata?.[alchemyMetadataKeys.instance],
              metadata?.[alchemyMetadataKeys.generation],
            ]);
            const group = byId.get(key) ?? [];
            group.push(machine);
            byId.set(key, group);
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

export interface ReconcileReplicasInput {
  fqn: string;
  resourceInstanceId: string;
  policy: DeploymentPolicy;
  checks?: Record<string, MachineCheck>;
  id: string;
  type: FlyAlchemyType;
  appName: string;
  baseName: string;
  /**
   * Regions to run in. `count` is the total replica count; replica `i`
   * runs in `regions[i % regions.length]`.
   */
  regions: readonly string[];
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
}

export const reconcileReplicas = (input: ReconcileReplicasInput) =>
  usingMachineLeases(input.appName, undefined, (leases) =>
    reconcileLeasedReplicas(input, leases),
  );

const reconcileLeasedReplicas = Effect.fn(function* (
  input: ReconcileReplicasInput,
  leases: MachineLeases,
) {
  const ownership = yield* createMachineMetadata(input.id, input.type);
  const alchemy = {
    ...ownership,
    [alchemyMetadataKeys.instance]: input.resourceInstanceId,
    [alchemyMetadataKeys.fqn]: input.fqn,
    [alchemyMetadataKeys.baseName]: input.baseName,
  };
  const buildConfig: ReconcileReplicasInput["buildConfig"] = (replica) => ({
    ...input.buildConfig(replica),
    checks:
      input.checks === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(input.checks).map(([name, check]) => [
              name,
              toFlyServiceCheck(check),
            ]),
          ),
    stop_config:
      input.policy.shutdown === undefined
        ? undefined
        : {
            signal: input.policy.shutdown.signal,
            timeout: input.policy.shutdown.timeout,
          },
  });
  const config = buildConfig({ index: 0, mounts: [], metadata: alchemy });
  yield* validateDeployment(
    input.policy,
    config,
    input.disks.length > 0,
    input.skipLaunch,
  );
  if (input.policy.bluegreen)
    return yield* reconcileBlueGreen(
      { ...input, buildConfig },
      ownership,
      alchemy,
      leases,
    );
  const desiredNames = new Set(
    Array.from({ length: input.count }, (_, index) =>
      replicaMachineName(input.baseName, index, input.count),
    ),
  );
  const listed = yield* listMachinesByApp(input.appName);
  const owned = yield* leaseSnapshot(
    input.appName,
    ownedReplicas(listed, {
      ...input,
      metadata: ownership,
      machineIds: input.outputMachineIds,
    }),
    leases,
  );
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
    if (
      name === undefined ||
      (!desiredNames.has(name) &&
        machine.config?.metadata?.[alchemyMetadataKeys.instance] !==
          input.resourceInstanceId)
    )
      continue;
    const index = replicaIndexOf(machine);
    if (!byIndex.has(index)) byIndex.set(index, machine);
  }

  const scaleDown = [...byIndex].filter(([index]) => index >= input.count);
  yield* retireMachines(
    input.appName,
    scaleDown.map(([, machine]) => machine),
    false,
    leases,
  );
  for (const [index] of scaleDown) byIndex.delete(index);

  // Volumes are regional: one group per disk and region, sized to the
  // replicas that run there.
  const replicasIn = (region: string) =>
    Array.from({ length: input.count }, (_, index) => index).filter(
      (index) => regionOfReplica(input.regions, index) === region,
    ).length;
  const groups: Array<{
    disk: DiskSpec;
    name: string;
    byRegion: Map<string, { volumes: FlyVolume[]; extras: FlyVolume[] }>;
  }> = [];
  for (const [diskIndex, disk] of input.disks.entries()) {
    const name = yield* volumeGroupName(input.id, disk);
    const preferIds = (input.preferVolumeIds ?? [])
      .map((replica) => replica[diskIndex])
      .filter((id): id is string => id !== undefined && id.length > 0);
    const byRegion = new Map<
      string,
      { volumes: FlyVolume[]; extras: FlyVolume[] }
    >();
    for (const region of input.regions) {
      byRegion.set(
        region,
        yield* ensureVolumeGroup({
          appName: input.appName,
          name,
          region,
          count: replicasIn(region),
          disk,
          preferIds,
        }),
      );
    }
    groups.push({ disk, name, byRegion });
  }

  const usedVolumeIds = new Set<string>();
  const live: FlyMachine[] = [];
  for (let index = 0; index < input.count; index++) {
    const name = replicaMachineName(input.baseName, index, input.count);
    const region = regionOfReplica(input.regions, index);
    const metadata = {
      ...alchemy,
      [alchemyMetadataKeys.replica]: String(index),
      ...(input.minSecretsVersion === undefined
        ? {}
        : {
            [alchemyMetadataKeys.secretsVersion]: String(
              input.minSecretsVersion,
            ),
          }),
    };
    const prefer = input.preferVolumeIds?.[index] ?? [];
    const mounts: FlyMachineMount[] = [];
    for (const [diskIndex, group] of groups.entries()) {
      const volume = pickVolume(
        group.byRegion.get(region)?.volumes ?? [],
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
    const config = buildConfig({ index, mounts, metadata });
    let current = byIndex.get(index);
    // Fly cannot move a Machine between regions. Machine names are unique
    // per App, so retire the old replica before creating it in its region.
    if (current !== undefined && current.region !== region) {
      yield* retireMachines(input.appName, [current], false, leases);
      byIndex.delete(index);
      current = undefined;
    }
    if (current === undefined) {
      const created = yield* machines
        .createMachine({
          app_name: input.appName,
          name,
          region,
          config,
          skip_launch: input.skipLaunch === true ? true : undefined,
          min_secrets_version: input.minSecretsVersion,
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
      current =
        created ??
        (yield* listMachinesByApp(input.appName).pipe(
          Effect.map((machines) =>
            ownedReplicas(machines, {
              ...input,
              metadata: ownership,
              machineIds: input.outputMachineIds,
            }).find((machine) => machine.name === name),
          ),
        ));
      if (current === undefined || current.id === undefined) {
        return yield* new ReplicaNotCreated({
          name,
          appName: input.appName,
        });
      }
      const observed = (yield* leaseSnapshot(
        input.appName,
        [current],
        leases,
      ))[0];
      if (!observed || input.configDrifted(observed, { mounts, metadata })) {
        return yield* new ReplicaNotCreated({ name, appName: input.appName });
      }
      current = observed;
    } else if (
      !sameChecks(current.config?.checks, config.checks) ||
      !sameStopConfig(current.config?.stop_config, config.stop_config) ||
      input.configDrifted(current, {
        mounts,
        metadata,
      })
    ) {
      const machineId = current.id!;
      const currentVersion = current.instance_id;
      const previous = current;
      const expected = { ...previous, config };
      yield* leases.mutate(machineId, (lease_nonce) =>
        machines
          .updateMachine({
            app_name: input.appName,
            machine_id: machineId,
            current_version: currentVersion,
            config,
            skip_launch: input.skipLaunch === true ? true : undefined,
            min_secrets_version: input.minSecretsVersion,
            lease_nonce,
          })
          .pipe(Effect.timeout("30 seconds")),
      );
      // Rolling opt-out removes generation metadata; observe that transition before startup.
      current = yield* leases.guard(
        Effect.gen(function* () {
          const observed = yield* machines
            .getMachine({
              app_name: input.appName,
              machine_id: machineId,
            })
            .pipe(Retry.none);
          if (
            !sameOwnership(observed, expected) &&
            !sameOwnership(observed, previous)
          )
            return yield* new ReplicaOwnershipChanged({
              appName: input.appName,
              machineId,
            });
          if (
            !sameOwnership(observed, expected) ||
            input.configDrifted(observed, { mounts, metadata }) ||
            !sameChecks(observed.config?.checks, config.checks) ||
            !sameStopConfig(observed.config?.stop_config, config.stop_config)
          )
            return yield* new ReplicaNotCreated({
              appName: input.appName,
              name,
            });
          return observed;
        }).pipe(
          Effect.retry({
            times: 8,
            schedule: waitBackoff,
            while: (error) =>
              error._tag === "Fly.ReplicaNotCreated" ||
              TRANSIENT_GET_TAGS.some((tag) => tag === error._tag),
          }),
          Effect.timeout("60 seconds"),
        ),
      );
    }

    current = yield* ensureStarted(
      input.appName,
      current,
      input.skipLaunch === true,
      input.policy.healthTimeoutMs,
      config,
      leases,
    );
    if (current.cordoned === true && !input.skipLaunch) {
      yield* setRouting(input.appName, current.id!, false, leases);
      if (hasPublishedService(config.services))
        yield* Effect.sleep("10 seconds");
      current = yield* waitHealthy(
        input.appName,
        current,
        input.policy.healthTimeoutMs,
        config,
      );
    }
    live.push(current);
  }

  const liveIds = new Set(live.map((machine) => machine.id));
  yield* retireMachines(
    input.appName,
    owned.filter((machine) => !liveIds.has(machine.id)),
    false,
    leases,
  );

  for (const group of groups) {
    for (const extra of [...group.byRegion.values()].flatMap(
      (placed) => placed.extras,
    )) {
      const volumeId = extra.id;
      if (volumeId === undefined || usedVolumeIds.has(volumeId)) continue;
      yield* deleteVolume(input.appName, volumeId);
    }
  }

  const volumesById = new Map<string, FlyVolume>();
  for (const group of groups) {
    for (const volume of [...group.byRegion.values()].flatMap(
      (placed) => placed.volumes,
    )) {
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
  id: string;
  type: FlyAlchemyType;
  fqn: string;
  resourceInstanceId: string;
  force?: boolean;
  machineIds: readonly string[];
  volumeIds: readonly string[];
}) {
  return yield* usingMachineLeases(input.appName, undefined, (leases) =>
    Effect.gen(function* () {
      const owned = yield* leaseSnapshot(
        input.appName,
        ownedReplicas(yield* listMachinesByApp(input.appName), {
          ...input,
          metadata: yield* createMachineMetadata(input.id, input.type),
        }),
        leases,
      );
      if (input.force) {
        yield* Effect.forEach(
          owned,
          (machine) =>
            Effect.gen(function* () {
              if (!machine.id) return;
              const current = yield* getMachineById(input.appName, machine.id);
              if (!current) return;
              if (!sameOwnership(current, machine))
                return yield* new ReplicaOwnershipChanged({
                  appName: input.appName,
                  machineId: machine.id,
                });
              yield* deleteMachine(input.appName, machine.id, leases);
            }),
          { concurrency: 4 },
        );
      } else yield* retireMachines(input.appName, owned, false, leases);
      yield* Effect.forEach(
        [...new Set(input.volumeIds)].filter((id) => id.length > 0),
        (volumeId) => deleteVolume(input.appName, volumeId),
        { concurrency: 4 },
      );
    }),
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

export const groupGenerations = (machines: FlyMachine[]) => {
  const groups = new Map<string | undefined, FlyMachine[]>();
  for (const machine of machines) {
    const generation =
      machine.config?.metadata?.[alchemyMetadataKeys.generation];
    const group = groups.get(generation) ?? [];
    group.push(machine);
    groups.set(generation, group);
  }
  return groups;
};

export const observeReplicaSet = Effect.fn(function* (input: {
  appName?: string;
  fqn: string;
  resourceInstanceId: string;
  id: string;
  type: FlyAlchemyType;
  machineIds?: readonly string[];
  baseName?: string;
}) {
  if (input.appName === undefined) return undefined;
  const owned = ownedReplicas(yield* listMachinesByApp(input.appName), {
    ...input,
    metadata: yield* createMachineMetadata(input.id, input.type),
  });
  const groups = groupGenerations(owned);
  const committed = [...groups.entries()]
    .filter(([generation, group]) => {
      if (generation === undefined) return false;
      const count = Number(
        group[0]?.config?.metadata?.[alchemyMetadataKeys.count],
      );
      if (
        group.some(
          (machine) => classifyDeploymentState(machine).protocol === "invalid",
        )
      )
        return false;
      const protocol2 = group.some(
        (machine) =>
          machine.config?.metadata?.[alchemyMetadataKeys.protocol] === "2",
      );
      if (protocol2 && !validProtocol2Generation(group)) return false;
      return (
        Number.isSafeInteger(count) &&
        count > 0 &&
        group.length === count &&
        new Set(group.map(replicaIndexOf)).size === count &&
        group.every((machine) => {
          const metadata = machine.config?.metadata;
          const index = replicaIndexOf(machine);
          return (
            index >= 0 &&
            index < count &&
            Number(metadata?.[alchemyMetadataKeys.count]) === count &&
            metadata?.[alchemyMetadataKeys.phase] === "active" &&
            machine.cordoned === false &&
            (metadata[alchemyMetadataKeys.protocol] === undefined ||
              ((metadata[alchemyMetadataKeys.protocol] === "1" ||
                metadata[alchemyMetadataKeys.protocol] === "2") &&
                metadata[alchemyMetadataKeys.restored] === "true" &&
                (metadata[alchemyMetadataKeys.role] === "idle" ||
                  (machine.instance_id !== undefined &&
                    metadata[alchemyMetadataKeys.checkedInstance] ===
                      machine.instance_id))))
          );
        })
      );
    })
    .sort(
      ([, a], [, b]) =>
        Number(b[0]?.config?.metadata?.[alchemyMetadataKeys.sequence] ?? 0) -
        Number(a[0]?.config?.metadata?.[alchemyMetadataKeys.sequence] ?? 0),
    );
  const legacy = (groups.get(undefined) ?? []).filter((machine) => {
    const { protocol } = classifyDeploymentState(machine);
    return protocol === "legacy" || protocol === "1";
  });
  const listed = (committed[0]?.[1] ?? legacy).sort(
    (a, b) => replicaIndexOf(a) - replicaIndexOf(b),
  );
  const rolloutPending = owned.some((machine) => !listed.includes(machine));
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
    return {
      ...toReplicaSet(
        replicas,
        input.appName,
        listed[0]?.config?.metadata?.[alchemyMetadataKeys.baseName] ??
          input.baseName ??
          replicas[0]?.name ??
          "",
        listed[0]?.config?.services,
      ),
      rolloutPending,
    };
  }
  if (owned.length)
    return {
      ...toReplicaSet([], input.appName, input.baseName ?? ""),
      region: owned[0]?.region ?? "",
      regions: [
        ...new Set(
          owned
            .map((machine) => machine.region ?? "")
            .filter((region) => region.length > 0),
        ),
      ],
      rolloutPending: true,
    };
  return undefined;
});
