import {
  EnvironmentId,
  type GatewayDriver,
  type GatewayDriverDrainResult,
  type GatewayDriverRemoveOptions,
  type GatewayDriverRemoveResult,
  type GatewayDriverSpawnOptions,
  type GatewayDriverSpawnResult,
  type GatewayDriverSpawnSpec,
  type GatewayDriverStatusSelector,
  isRuntimeModeAbove,
  OpenShellDrainProgress,
  OpenShellFleetState,
  OpenShellFleetWorkerStatus,
  type OpenShellSandboxTemplate,
  OpenShellSharedCacheSettings,
  OpenShellWorkerClass,
  type OpenShellWorkerDefaults,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import {
  type OpenShellGatewayClient,
  type OpenShellTemplateCreateSpec,
  PAIRING_INFO_COMMAND,
  FLEET_ROLE_LABEL,
  MANAGED_BY_LABEL,
  WORKER_CLASS_LABEL,
  parseWorkerPairingMaterial,
} from "./gatewayClient.ts";
import { sandboxPolicyForRuntimeMode } from "./sandboxPolicy.ts";

/**
 * The OpenShell fleet driver (spec section 12): sandbox lifecycle, template
 * selection, pairing handoff, drain-first removal, orphan sweep, TTL. The
 * registry, drain data plane, pairing protocol and audit stay t3-native;
 * collaborators are injected so unit tests run without a network.
 */

/** Image prep + supervisor startup deadline on the gateway (lane 1: 1800 s default). */
const IMAGE_PREP_TIMEOUT_SECS = 1800;
/** Ephemeral hard lifetime cap when nothing overrides it (spec section 6.1: 24 h). */
const DEFAULT_WORKER_TTL_MS = 86_400_000;
/** Drain must finish in 10 min or the sandbox is kept (spec section 4.1). */
const DEFAULT_DRAIN_TIMEOUT_MS = 600_000;
/**
 * Unregistered fleet sandboxes younger than this are left alone by the sweep.
 * OPEN-QUESTION (spec section 5.6): the spec pins no grace length; chosen so a
 * spawn interrupted between create and pairing is not swept mid-boot.
 */
const DEFAULT_ORPHAN_GRACE_MS = 30 * 60_000;
/** Label value for `t3-managed-by` when no managing environment id is configured. */
const DEFAULT_MANAGED_BY = "t3-fleet";

export class OpenShellGatewayDriverError extends Schema.TaggedError<OpenShellGatewayDriverError>()(
  "OpenShellGatewayDriverError",
  {
    reason: Schema.Literals([
      "unknown_template",
      "unknown_worker",
      "pairing",
      "gateway",
      "runtime_mode_above_ceiling",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Settings-driven spawn defaults (spec section 4.2); per-call spec overrides them. */
export interface OpenShellDriverSettings {
  readonly defaultSandboxTemplate?: string;
  readonly workerDefaults?: OpenShellWorkerDefaults;
  readonly sharedCache?: OpenShellSharedCacheSettings;
}

/**
 * Pairing handoff into the phase-2 peer registry. `apps/server` adapts
 * `PeerEnvironmentRegistry` (Effect) to this Promise shape — its
 * `register`/`exchangeBootstrap` inputs already match this exactly.
 */
export interface WorkerPairingRegistrar {
  readonly register: (input: {
    readonly environmentId: EnvironmentId;
    readonly role: "worker";
    readonly label: string;
    readonly urls: ReadonlyArray<string>;
    readonly workerClass: OpenShellWorkerClass;
  }) => Promise<unknown>;
  readonly exchangeBootstrap: (input: {
    readonly environmentId: EnvironmentId;
    readonly bootstrapCredential: string;
  }) => Promise<unknown>;
}

/** One drain run of the nothing-lost protocol (spec section 7); the data plane itself stays t3-native. */
export interface FleetDrainExecutor {
  readonly drain: (input: {
    readonly environmentId: EnvironmentId;
    readonly sandboxName: string;
    /** Deterministic `drain:<envId>:<generation>`; retries reuse it. */
    readonly drainId: string;
    /** `force` removal: thread snapshots only, worktree pushes are skipped. */
    readonly snapshotOnly: boolean;
    /** Epoch ms; the executor must give up by then so removal can refuse. */
    readonly deadlineAt: number;
  }) => Promise<FleetDrainOutcome>;
}

export interface FleetDrainOutcome {
  readonly threads: { readonly total: number; readonly acked: number; readonly failed: number };
  readonly worktrees: { readonly total: number; readonly acked: number; readonly failed: number };
  /** `acked`: verified complete; `draining`: still running (resumable); `failed`: sandbox kept. */
  readonly state: "acked" | "draining" | "failed";
  readonly finishedAt: number | null;
}

/** One worker as the fleet index keeps it; mirrors the phase-2 `OpenShellFleetStore` rows. */
export interface FleetWorkerRow {
  readonly environmentId: EnvironmentId;
  readonly state: OpenShellFleetState;
  readonly workerClass: OpenShellWorkerClass;
  readonly label: string | null;
  readonly sandboxName: string | null;
  readonly sandboxId: string | null;
  readonly drain: OpenShellDrainProgress | null;
  readonly expiresAt: number | null;
  readonly lastError: string | null;
}

/**
 * The durable fleet state. Same surface as the phase-2
 * `OpenShellFleetStore` (sqlite), Promise-ified; the default keeps rows in
 * memory, the server wires the store for restart survival (spec section 5.5).
 */
export interface FleetWorkerIndex {
  readonly upsert: (input: {
    readonly environmentId: EnvironmentId;
    readonly state: OpenShellFleetState;
    readonly workerClass: OpenShellWorkerClass;
    readonly label?: string;
    readonly sandboxName?: string;
    readonly sandboxId?: string;
    readonly expiresAt?: number;
  }) => Promise<FleetWorkerRow>;
  readonly setState: (
    environmentId: EnvironmentId,
    state: OpenShellFleetState,
    lastError?: string,
  ) => Promise<FleetWorkerRow | null>;
  readonly setDrain: (
    environmentId: EnvironmentId,
    drain: OpenShellDrainProgress | null,
  ) => Promise<FleetWorkerRow | null>;
  readonly get: (environmentId: EnvironmentId) => Promise<FleetWorkerRow | null>;
  readonly list: () => Promise<ReadonlyArray<FleetWorkerRow>>;
  readonly remove: (environmentId: EnvironmentId) => Promise<boolean>;
}

const decodeWorkerClass = Schema.decodeUnknownSync(OpenShellWorkerClass);

class DrainDeadlineError extends Schema.TaggedError<DrainDeadlineError>()("DrainDeadlineError", {
  timeoutMs: Schema.Number,
}) {}

/**
 * Fallback idempotency key when the caller omits one. Retries must pass the
 * same key to converge, so process-local uniqueness is enough here.
 */
let fallbackKeyCounter = 0;
const fallbackIdempotencyKey = (): string => `t3-${(fallbackKeyCounter++).toString(36)}`;

/**
 * Deterministic sandbox-name hash (spec section 5.4). Stability is what
 * matters, not cryptographic strength — ids are unique per spawn — so a
 * plain FNV-1a pair avoids a crypto dependency here.
 */
const sandboxNameHash = (seed: string, key: string): string => {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ a;
  for (const byte of Buffer.from(`${seed}\u0000${key}`, "utf8")) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b ^ byte, 0x1b873593) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`.slice(0, 12);
};

/** Loser of the race keeps running; the journal makes it resumable. */
/**
 * Races a drain against its deadline and clears the timer either way. The
 * timeout itself is fenced by the caller: a run that keeps writing after it
 * timed out writes under the old drain id, which no retry reads.
 */
const withDeadline = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        // @effect-diagnostics-next-line globalTimers:off - The driver is Promise-based, outside an Effect runtime.
        timer = setTimeout(() => reject(new DrainDeadlineError({ timeoutMs })), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export interface GatewayDriverSpawnOptionsWithCeiling extends GatewayDriverSpawnOptions {
  /**
   * The broadest worker policy this driver may apply (spec section 5.2); the
   * caller's own ceiling. A requested mode above it fails typed before any
   * gateway call, so a supervised caller cannot mint a permissive worker.
   */
  readonly runtimeModeCeiling?: RuntimeMode;
}

/** In-memory index; process restart loses it, so servers inject a durable one. */
export const memoryFleetWorkerIndex = (): FleetWorkerIndex => {
  const rows = new Map<string, FleetWorkerRow>();
  return {
    upsert: async (input) => {
      const previous = rows.get(input.environmentId);
      const row: FleetWorkerRow = {
        environmentId: input.environmentId,
        state: input.state,
        workerClass: decodeWorkerClass(input.workerClass),
        label: input.label ?? previous?.label ?? null,
        sandboxName: input.sandboxName ?? previous?.sandboxName ?? null,
        sandboxId: input.sandboxId ?? previous?.sandboxId ?? null,
        drain: previous?.drain ?? null,
        expiresAt: input.expiresAt ?? previous?.expiresAt ?? null,
        lastError: null,
      };
      rows.set(input.environmentId, row);
      return row;
    },
    setState: async (environmentId, state, lastError) => {
      const previous = rows.get(environmentId);
      if (previous === undefined) return null;
      const row: FleetWorkerRow = { ...previous, state, lastError: lastError ?? null };
      rows.set(environmentId, row);
      return row;
    },
    setDrain: async (environmentId, drain) => {
      const previous = rows.get(environmentId);
      if (previous === undefined) return null;
      const row: FleetWorkerRow = { ...previous, drain };
      rows.set(environmentId, row);
      return row;
    },
    get: async (environmentId) => rows.get(environmentId) ?? null,
    list: async () => [...rows.values()],
    remove: async (environmentId) => rows.delete(environmentId),
  };
};

export interface OrphanSweepResult {
  /** Fleet-labeled sandboxes with no registry row, past grace: deleted. */
  readonly swept: ReadonlyArray<{
    readonly sandboxName: string;
    readonly sandboxOutcome: "completed" | "accepted" | "already_absent";
  }>;
  /** Registry rows whose sandbox is gone: finalized. */
  readonly finalized: ReadonlyArray<EnvironmentId>;
  /** Kept on purpose, with the reason (drain unfinished, within grace, unknown age). */
  readonly leftInPlace: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  /** Ephemeral workers past their TTL, released drain-first by the sweep (spec section 5.6.4). */
  readonly ttlExpired: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly outcome: GatewayDriverRemoveResult["outcome"];
  }>;
}

export interface OpenShellGatewayDriverOptions {
  readonly client: OpenShellGatewayClient;
  /** Settings block `openshell` (spec section 4.2): template + worker defaults. */
  readonly settings?: OpenShellDriverSettings;
  /** Label anchor `t3-managed-by`; unknown sandboxes of the fleet carry this. */
  readonly managingEnvironmentId?: string;
  /** Phase-2 `PeerEnvironmentRegistry` adapter; absent, spawn fails after ready. */
  readonly registrar?: WorkerPairingRegistrar;
  /** Drain protocol adapter; absent, drain fails and removal refuses. */
  readonly drainExecutor?: FleetDrainExecutor;
  readonly index?: FleetWorkerIndex;
  /** Epoch-ms clock, injectable for TTL tests. */
  readonly now?: () => number;
}

const toMillis = (value: number | Duration.Duration | undefined): number | undefined =>
  value === undefined ? undefined : typeof value === "number" ? value : Duration.toMillis(value);

const drainTimeoutMsOf = (defaults: OpenShellWorkerDefaults | undefined): number =>
  toMillis(defaults?.drainTimeoutMs) ?? DEFAULT_DRAIN_TIMEOUT_MS;

const drainIdOf = (environmentId: EnvironmentId): string => `drain:${environmentId}:1`;

/** The next drain run's id: a timed-out run keeps writing under the old one. */
const nextGeneration = (drainId: string, environmentId: EnvironmentId): string => {
  const generation = Number.parseInt(drainId.slice(drainId.lastIndexOf(":") + 1), 10);
  return `drain:${environmentId}:${Number.isFinite(generation) ? generation + 1 : 1}`;
};

const zeroProgress = (drainId: string, startedAt: number): OpenShellDrainProgress => ({
  drainId,
  threads: { total: 0, acked: 0, failed: 0 },
  worktrees: { total: 0, acked: 0, failed: 0 },
  startedAt,
  finishedAt: null,
});

/** Fulfills the contracts `GatewayDriver` interface (spec section 12). */
export class OpenShellGatewayDriver implements GatewayDriver {
  readonly id = "openshell";

  private readonly client: OpenShellGatewayClient;
  private readonly settings: OpenShellDriverSettings | undefined;
  private readonly managedBy: string;
  /** This managing instance's own id: a worker must never claim it. */
  private readonly managingEnvironmentId: string | undefined;
  private readonly registrar: WorkerPairingRegistrar | undefined;
  private readonly drainExecutor: FleetDrainExecutor | undefined;
  private readonly index: FleetWorkerIndex;
  private readonly now: () => number;

  constructor(options: OpenShellGatewayDriverOptions) {
    this.client = options.client;
    this.settings = options.settings;
    this.managedBy = options.managingEnvironmentId ?? DEFAULT_MANAGED_BY;
    this.managingEnvironmentId = options.managingEnvironmentId;
    this.registrar = options.registrar;
    this.drainExecutor = options.drainExecutor;
    this.index = options.index ?? memoryFleetWorkerIndex();
    this.now = options.now ?? Date.now;
  }

  listTemplates(): Promise<ReadonlyArray<OpenShellSandboxTemplate>> {
    return this.client.listTemplates();
  }

  /**
   * Provisions a gateway `SandboxWorkloadTemplate` (spec section 9): image,
   * env, resources in the template; shared-volume mounts via driver config;
   * fleet role label for the desktop picker. Setup scripts stay out: they run
   * per thread via worktreeSetup stages (lane 1 forbids inline workload flags).
   */
  async createSandboxFromTemplate(
    spec: OpenShellTemplateCreateSpec,
  ): Promise<OpenShellSandboxTemplate> {
    return await this.client.createTemplate(spec);
  }

  /**
   * Template selection (spec sections 4.2 and 5.1): per-call `spec.template`
   * first, then the settings default; neither fails typed. Sandbox name is
   * deterministic from the idempotency key so retries converge (section 5.4).
   */
  async spawn(
    spec: GatewayDriverSpawnSpec,
    options: GatewayDriverSpawnOptionsWithCeiling = {},
  ): Promise<GatewayDriverSpawnResult> {
    const runtimeMode = spec.runtimeMode ?? "approval-required";
    if (isRuntimeModeAbove(runtimeMode, options.runtimeModeCeiling)) {
      throw new OpenShellGatewayDriverError({
        reason: "runtime_mode_above_ceiling",
        message: `Worker policy ${runtimeMode} is broader than this caller's ${options.runtimeModeCeiling} ceiling; no sandbox was created.`,
      });
    }
    const template = spec.template ?? this.settings?.defaultSandboxTemplate;
    if (template === undefined || template.trim() === "") {
      throw new OpenShellGatewayDriverError({
        reason: "unknown_template",
        message: "No sandbox template: pass spec.template or set settings.defaultSandboxTemplate.",
      });
    }
    const idempotencyKey = options.idempotencyKey ?? fallbackIdempotencyKey();
    const name = `t3-worker-${sandboxNameHash(this.managedBy, idempotencyKey)}`;
    const labels = {
      [FLEET_ROLE_LABEL]: "worker",
      [MANAGED_BY_LABEL]: this.managedBy,
      [WORKER_CLASS_LABEL]: spec.workerClass,
    };
    // A retry with the same idempotency key may return an already-registered
    // sandbox, so a policy failure keeps it: deleting could destroy a live
    // worker without drain and strand its fleet row.
    const preExisting = (await this.client.get(name)) !== null;
    const created = await this.client.createFromTemplate({
      template,
      name,
      labels,
      requestId: idempotencyKey,
    });

    // Policy translation (spec section 5.2). A sandbox this attempt created
    // but whose policy cannot be set is deleted again: it would otherwise be
    // invisible to status, TTL and removal.
    try {
      await this.client.setPolicy(created.name, sandboxPolicyForRuntimeMode(runtimeMode));
    } catch (cause) {
      if (preExisting) {
        throw new OpenShellGatewayDriverError({
          reason: "gateway",
          message:
            `The sandbox policy could not be set for the existing sandbox ${created.name}; ` +
            "it was kept, because a previous attempt may already have registered it.",
          cause,
        });
      }
      let deleteFailure: unknown;
      try {
        await this.client.deleteSandbox(created.name);
      } catch (deleteCause) {
        deleteFailure = deleteCause;
      }
      throw new OpenShellGatewayDriverError({
        reason: "gateway",
        message:
          deleteFailure === undefined
            ? `The sandbox policy could not be set; ${created.name} was deleted again.`
            : `The sandbox policy could not be set and ${created.name} could not be deleted; ` +
              "it remains for the orphan sweep to reclaim.",
        cause: deleteFailure === undefined ? cause : { cause, deleteFailure },
      });
    }
    const ready = await this.client.waitReady(created.name, IMAGE_PREP_TIMEOUT_SECS);

    if (this.registrar === undefined) {
      throw new OpenShellGatewayDriverError({
        reason: "pairing",
        message:
          `Sandbox ${ready.name} is ready but no worker registrar is configured; ` +
          "the sandbox stays up and the orphan sweep reclaims it if pairing is never retried.",
      });
    }
    const exec = await this.client.exec(ready.name, [...PAIRING_INFO_COMMAND]);
    if (exec.exitCode !== 0) {
      throw new OpenShellGatewayDriverError({
        reason: "pairing",
        message: `The worker did not report pairing material (exit ${exec.exitCode}).`,
        cause: exec.stderr,
      });
    }
    let material;
    try {
      material = parseWorkerPairingMaterial(exec.stdout);
    } catch (cause) {
      throw new OpenShellGatewayDriverError({
        reason: "pairing",
        message: "The worker's pairing output could not be parsed.",
        cause,
      });
    }
    const environmentId = EnvironmentId.make(material.environmentId);
    const label = spec.label ?? ready.name;
    const ttlMs =
      spec.ttlMs ?? toMillis(this.settings?.workerDefaults?.ttlMs) ?? DEFAULT_WORKER_TTL_MS;
    const expiresAt = spec.workerClass === "ephemeral" ? this.now() + ttlMs : null;

    if (environmentId === this.managingEnvironmentId) {
      throw new OpenShellGatewayDriverError({
        reason: "pairing",
        message: `${environmentId} is this managing instance; a worker cannot report it.`,
      });
    }
    const existing = await this.index.get(environmentId);
    if (existing !== null && existing.sandboxName !== null && existing.sandboxName !== ready.name) {
      // A worker claiming another worker's id would let a later removal target the
      // wrong sandbox, so the binding is never replaced.
      throw new OpenShellGatewayDriverError({
        reason: "pairing",
        message: `${environmentId} is already bound to sandbox ${existing.sandboxName}; ${ready.name} was not registered.`,
      });
    }
    await this.index.upsert({
      environmentId,
      state: "pairing",
      workerClass: spec.workerClass,
      label,
      sandboxName: ready.name,
      sandboxId: ready.sandboxId,
      ...(expiresAt === null ? {} : { expiresAt }),
    });
    await this.registrar.register({
      environmentId,
      role: "worker",
      label,
      urls: [material.url],
      workerClass: spec.workerClass,
    });
    await this.registrar.exchangeBootstrap({
      environmentId,
      bootstrapCredential: material.bootstrapCredential,
    });
    await this.index.setState(environmentId, "ready");

    const warnings: string[] = [];
    if (
      this.settings?.sharedCache !== undefined &&
      this.settings.sharedCache.enabled &&
      this.settings.sharedCache.mode !== "rwx-pvc"
    ) {
      warnings.push(
        `shared cache disabled: mode ${this.settings.sharedCache.mode} without an RWX class (spec section 8.4)`,
      );
    }
    return {
      environmentId,
      sandbox: {
        name: ready.name,
        sandboxId: ready.sandboxId,
        template,
        phase: ready.phase,
      },
      workerClass: spec.workerClass,
      state: "ready",
      expiresAt,
      warnings,
    };
  }

  /** Contracts verb: a plain drain with the settings drain timeout. */
  drain(
    environmentId: EnvironmentId,
    options: { timeoutMs?: number } = {},
  ): Promise<GatewayDriverDrainResult> {
    return this.drainForRemoval(environmentId, options);
  }

  private async drainForRemoval(
    environmentId: EnvironmentId,
    options: { timeoutMs?: number; snapshotOnly?: boolean } = {},
  ): Promise<GatewayDriverDrainResult> {
    const row = await this.index.get(environmentId);
    if (row === null || row.sandboxName === null) {
      throw new OpenShellGatewayDriverError({
        reason: "unknown_worker",
        message: `${environmentId} is not a fleet worker with a sandbox.`,
      });
    }
    const drainId = row.drain?.drainId ?? drainIdOf(environmentId);
    const startedAt = row.drain?.startedAt ?? this.now();
    const timeoutMs = options.timeoutMs ?? drainTimeoutMsOf(this.settings?.workerDefaults);
    const deadlineAt = this.now() + timeoutMs;

    if (this.drainExecutor === undefined) {
      const progress = zeroProgress(drainId, startedAt);
      await this.index.setDrain(environmentId, progress);
      await this.index.setState(
        environmentId,
        "failed",
        "No drain executor is configured; nothing was drained, so the sandbox is kept.",
      );
      return { drainId, progress, state: "failed" };
    }

    await this.index.setState(environmentId, "draining");
    let outcome;
    try {
      outcome = await withDeadline(
        this.drainExecutor.drain({
          environmentId,
          sandboxName: row.sandboxName,
          drainId,
          snapshotOnly: options.snapshotOnly === true,
          deadlineAt,
        }),
        timeoutMs,
      );
    } catch {
      // Timed out or crashed. The next attempt gets a new drain id, so a run that
      // is still writing cannot land under the id a retry would trust, and the
      // journal keeps whatever acked so a retry resumes instead of restarting.
      const progress = zeroProgress(nextGeneration(drainId, environmentId), this.now());
      await this.index.setDrain(environmentId, progress);
      await this.index.setState(environmentId, "draining", "drain still running");
      return { drainId: progress.drainId, progress, state: "draining" };
    }
    // A failed drain must not leave its id behind: the next attempt gets a new
    // generation, so copies it could not verify are never trusted again.
    const resolvedDrainId =
      outcome.state === "failed" ? nextGeneration(drainId, environmentId) : drainId;
    const progress: OpenShellDrainProgress = {
      drainId: resolvedDrainId,
      threads: outcome.threads,
      worktrees: outcome.worktrees,
      startedAt,
      finishedAt: outcome.finishedAt ?? (outcome.state === "acked" ? this.now() : null),
    };
    await this.index.setDrain(environmentId, progress);
    if (outcome.state === "acked") {
      await this.index.setState(environmentId, "deleting");
      return { drainId, progress, state: "deleting" };
    }
    await this.index.setState(
      environmentId,
      outcome.state === "draining" ? "draining" : "failed",
      outcome.state === "draining" ? "drain still running" : "drain failed",
    );
    return { drainId: resolvedDrainId, progress, state: outcome.state };
  }

  /**
   * Drain-first removal (spec sections 5.3 and 7): while the drain is
   * incomplete the sandbox is KEPT and the typed outcome says so; deletion
   * only after every thread and worktree acked. `force` still snapshots
   * threads (section 11.4); a delete transport error stays resumable.
   */
  async remove(
    environmentId: EnvironmentId,
    options: GatewayDriverRemoveOptions = {},
  ): Promise<GatewayDriverRemoveResult> {
    const row = await this.index.get(environmentId);
    if (row === null || row.sandboxName === null) {
      return { environmentId, outcome: "refused", reason: "unknown_worker" };
    }
    let drain: OpenShellDrainProgress | undefined;
    if (row.state !== "deleting") {
      const drained = await this.drainForRemoval(environmentId, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        snapshotOnly: options.force === true,
      });
      drain = drained.progress;
      if (drained.state === "draining") {
        return { environmentId, outcome: "drain_pending", drain };
      }
      if (drained.state === "failed") {
        return {
          environmentId,
          outcome: "refused",
          drain,
          reason: row.lastError ?? "drain failed; the sandbox is kept (nothing lost)",
        };
      }
    }
    let sandboxOutcome: GatewayDriverRemoveResult["sandboxOutcome"];
    try {
      sandboxOutcome = await this.client.deleteSandbox(row.sandboxName, {
        requestId: options.idempotencyKey ?? `t3-remove:${environmentId}`,
      });
    } catch (cause) {
      throw new OpenShellGatewayDriverError({
        reason: "gateway",
        message: `Deleting sandbox ${row.sandboxName} failed; the sandbox is kept and removal can be retried.`,
        cause,
      });
    }
    await this.index.remove(environmentId);
    return {
      environmentId,
      outcome: "completed",
      ...(drain === undefined ? {} : { drain }),
      sandboxOutcome,
    };
  }

  async status(
    selector: GatewayDriverStatusSelector = {},
  ): Promise<ReadonlyArray<OpenShellFleetWorkerStatus>> {
    const rows = await this.index.list();
    return rows
      .filter(
        (row) =>
          row.sandboxName !== null &&
          (selector.environmentId === undefined || row.environmentId === selector.environmentId) &&
          (selector.workerClass === undefined || row.workerClass === selector.workerClass),
      )
      .map((row) => ({
        environmentId: row.environmentId,
        label: row.label,
        sandboxName: row.sandboxName as string,
        workerClass: row.workerClass,
        state: row.state,
        expiresAt: row.expiresAt,
        ...(row.drain === undefined || row.drain === null ? {} : { drain: row.drain }),
        lastError: row.lastError,
      }));
  }

  /**
   * TTL enforcement for ephemeral workers (spec sections 5.6.4 and 6.1):
   * OpenShell has no native TTL, so past-deadline workers are released
   * drain-first here. The idle dial needs activity heartbeats; v1 enforces
   * the hard lifetime only (OPEN-QUESTION, spec section 5.6).
   */
  async enforceTtl(now: number = this.now()): Promise<{
    expired: ReadonlyArray<{
      environmentId: EnvironmentId;
      outcome: GatewayDriverRemoveResult["outcome"];
    }>;
  }> {
    const rows = await this.index.list();
    const expired: Array<{
      environmentId: EnvironmentId;
      outcome: GatewayDriverRemoveResult["outcome"];
    }> = [];
    for (const row of rows) {
      if (row.workerClass !== "ephemeral" || row.expiresAt === null || row.expiresAt > now)
        continue;
      try {
        expired.push({
          environmentId: row.environmentId,
          outcome: (await this.remove(row.environmentId)).outcome,
        });
      } catch {
        expired.push({ environmentId: row.environmentId, outcome: "refused" });
      }
    }
    return { expired };
  }

  /**
   * Orphan sweep (spec section 5.6), idempotent: fleet-labeled sandboxes with
   * no registry row are deleted once past grace; rows whose sandbox is gone
   * are finalized; rows with an unfinished drain are never force-deleted;
   * expired ephemeral workers are released drain-first.
   */
  async orphanSweep(options: { graceMs?: number; now?: number } = {}): Promise<OrphanSweepResult> {
    const now = options.now ?? this.now();
    const graceMs = options.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
    const sandboxes = await this.client.listAll({
      labels: { [FLEET_ROLE_LABEL]: "worker", [MANAGED_BY_LABEL]: this.managedBy },
    });
    const rows = await this.index.list();
    const sandboxNames = new Set(sandboxes.map((sandbox) => sandbox.name));
    const rowBySandboxName = new Map(
      rows.filter((row) => row.sandboxName !== null).map((row) => [row.sandboxName as string, row]),
    );

    const swept: Array<{
      sandboxName: string;
      sandboxOutcome: "completed" | "accepted" | "already_absent";
    }> = [];
    const leftInPlace: Array<{ name: string; reason: string }> = [];
    for (const sandbox of sandboxes) {
      if (rowBySandboxName.has(sandbox.name)) continue;
      if (sandbox.createdAt === null) {
        leftInPlace.push({ name: sandbox.name, reason: "the gateway reports no creation time" });
        continue;
      }
      if (now - sandbox.createdAt < graceMs) {
        leftInPlace.push({ name: sandbox.name, reason: "within orphan grace" });
        continue;
      }
      try {
        swept.push({
          sandboxName: sandbox.name,
          sandboxOutcome: await this.client.deleteSandbox(sandbox.name, {
            requestId: `t3-sweep:${sandbox.name}`,
          }),
        });
      } catch (cause) {
        leftInPlace.push({
          name: sandbox.name,
          reason: `delete failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }

    const finalized: Array<EnvironmentId> = [];
    for (const row of rows) {
      if (row.sandboxName !== null && sandboxNames.has(row.sandboxName)) continue;
      // The labeled list is not proof of absence: a sandbox created under another
      // managing id (or before a rename) is missing from it while still running,
      // and finalizing its row would hide a live worker from status and removal.
      if (row.sandboxName !== null) {
        const sandbox = await this.client.get(row.sandboxName).catch(() => null);
        if (sandbox !== null) {
          leftInPlace.push({
            name: row.sandboxName,
            reason: "the sandbox still exists under another label",
          });
          continue;
        }
      }
      const drainUnfinished = row.drain !== null && row.drain.finishedAt === null;
      if (row.state === "draining" || row.state === "deleting" || drainUnfinished) {
        leftInPlace.push({
          name: row.sandboxName ?? row.environmentId,
          reason: "drain unfinished; never force-delete (spec section 5.6.3)",
        });
        continue;
      }
      if (await this.index.remove(row.environmentId)) finalized.push(row.environmentId);
    }

    return { swept, finalized, leftInPlace, ttlExpired: (await this.enforceTtl(now)).expired };
  }
}
