import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Duration from "effect/Duration";

import {
  OpenShellGatewayDriver,
  memoryFleetWorkerIndex,
  type FleetDrainExecutor,
  type FleetDrainOutcome,
  type WorkerPairingRegistrar,
} from "./OpenShellGatewayDriver.ts";
import {
  type OpenShellExecResult,
  type OpenShellGatewayClient,
  type OpenShellSandboxCreateSpec,
  type OpenShellSandboxView,
} from "./gatewayClient.ts";
import { sandboxPolicyForRuntimeMode } from "./sandboxPolicy.ts";

const NOW = 1_700_000_000_000;

const workerEnvId = (id: string) => EnvironmentId.make(id);

const sandboxView = (
  name: string,
  overrides: Partial<OpenShellSandboxView> = {},
): OpenShellSandboxView => ({
  name,
  sandboxId: `sbx-${name}`,
  phase: "Ready",
  labels: {},
  createdAt: NOW,
  ...overrides,
});

const PAIRING_URL = "https://worker.example.com/mcp";
const PAIRING_CREDENTIAL = "pair-one-time-1";

interface ClientRecording {
  createCalls: OpenShellSandboxCreateSpec[];
  policyCalls: Array<{ name: string; policy: unknown }>;
  waitReadyCalls: Array<{ name: string; timeoutSecs: number }>;
  execCalls: Array<{ name: string; command: string[] }>;
  deleteCalls: Array<{ name: string; requestId?: string }>;
  templateCreates: Array<Record<string, unknown>>;
}

interface FakeClientOptions {
  /** The pairing exec result; defaults to valid material with exit 0. */
  execResult?: () => OpenShellExecResult;
  deleteOutcome?: "completed" | "accepted" | "already_absent";
  deleteError?: Error;
  /** Sandboxes the gateway already holds. */
  sandboxes?: OpenShellSandboxView[];
}

const fakeClient = (options: FakeClientOptions = {}) => {
  const recording: ClientRecording = {
    createCalls: [],
    policyCalls: [],
    waitReadyCalls: [],
    execCalls: [],
    deleteCalls: [],
    templateCreates: [],
  };
  const sandboxes = new Map<string, OpenShellSandboxView>();
  /** Sandbox name → idempotency key, so each worker pairs as its own environment. */
  const requestKeys = new Map<string, string>();
  for (const sandbox of options.sandboxes ?? []) sandboxes.set(sandbox.name, sandbox);
  const client: OpenShellGatewayClient = {
    health: async () => {},
    createFromTemplate: async (spec) => {
      recording.createCalls.push(spec);
      const view = sandboxView(
        spec.name ?? `sbx-${recording.createCalls.length}`,
        spec.labels === undefined ? {} : { labels: spec.labels },
      );
      sandboxes.set(view.name, view);
      if (spec.name !== undefined && spec.requestId !== undefined) {
        requestKeys.set(spec.name, spec.requestId);
      }
      return view;
    },
    get: async (name) => sandboxes.get(name) ?? null,
    listAll: async (selector) => {
      const all = [...sandboxes.values()];
      const labels = selector?.labels ?? {};
      return all.filter((sandbox) =>
        Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value),
      );
    },
    deleteSandbox: async (name, requestOptions) => {
      recording.deleteCalls.push({
        name,
        ...(requestOptions === undefined ? {} : { requestId: requestOptions.requestId }),
      });
      if (options.deleteError !== undefined) throw options.deleteError;
      sandboxes.delete(name);
      return options.deleteOutcome ?? "completed";
    },
    waitReady: async (name, timeoutSecs) => {
      recording.waitReadyCalls.push({ name, timeoutSecs });
      return sandboxes.get(name) ?? sandboxView(name);
    },
    exec: async (name, command) => {
      recording.execCalls.push({ name, command: [...command] });
      if (options.execResult !== undefined) return options.execResult();
      const environmentId = `environment-${requestKeys.get(name) ?? "unknown"}`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          environmentId,
          url: PAIRING_URL,
          bootstrapCredential: PAIRING_CREDENTIAL,
        }),
        stderr: "",
      };
    },
    setPolicy: async (name, policy) => {
      recording.policyCalls.push({ name, policy });
    },
    listTemplates: async () => [],
    createTemplate: async (spec) => {
      recording.templateCreates.push({ ...spec });
      return {
        name: spec.name,
        ...(spec.image === undefined ? {} : { image: spec.image }),
        ...(spec.cpu === undefined ? {} : { cpu: spec.cpu }),
        ...(spec.memory === undefined ? {} : { memory: spec.memory }),
        ...(spec.role === undefined ? {} : { role: spec.role }),
      };
    },
  };
  return { client, recording, sandboxes };
};

const fakeRegistrar = () => {
  const registrations: Array<{
    environmentId: EnvironmentId;
    role: string;
    label: string;
    urls: ReadonlyArray<string>;
    workerClass: string;
  }> = [];
  const exchanges: Array<{ environmentId: EnvironmentId; bootstrapCredential: string }> = [];
  const registrar: WorkerPairingRegistrar = {
    register: async (input) => {
      registrations.push(input);
      return {};
    },
    exchangeBootstrap: async (input) => {
      exchanges.push(input);
      return {};
    },
  };
  return { registrar, registrations, exchanges };
};

const ackOutcome = (): FleetDrainOutcome => ({
  threads: { total: 2, acked: 2, failed: 0 },
  worktrees: { total: 1, acked: 1, failed: 0 },
  state: "acked",
  finishedAt: NOW,
});

interface FakeExecutorOptions {
  outcome?: () => FleetDrainOutcome;
  /** When true the executor never answers — only the driver deadline can win. */
  hang?: boolean;
}

const fakeExecutor = (options: FakeExecutorOptions = {}) => {
  const calls: Array<{
    drainId: string;
    snapshotOnly: boolean;
    sandboxName: string;
    deadlineAt: number;
  }> = [];
  const executor: FleetDrainExecutor = {
    drain: async (input) => {
      calls.push({
        drainId: input.drainId,
        snapshotOnly: input.snapshotOnly,
        sandboxName: input.sandboxName,
        deadlineAt: input.deadlineAt,
      });
      if (options.hang === true) return new Promise<FleetDrainOutcome>(() => {});
      return options.outcome?.() ?? ackOutcome();
    },
  };
  return { executor, calls };
};

type DriverOptions = ConstructorParameters<typeof OpenShellGatewayDriver>[0];

/** Pairs by default; the no-registrar test constructs the driver directly. */
const makeDriver = (overrides: Partial<DriverOptions> = {}) =>
  new OpenShellGatewayDriver({
    client: fakeClient().client,
    registrar: fakeRegistrar().registrar,
    now: () => NOW,
    ...overrides,
  });

const DEFAULT_SETTINGS = { defaultSandboxTemplate: "t3-worker" } as const;

const spawnEphemeral = async (driver: OpenShellGatewayDriver, idempotencyKey = "req-1") =>
  await driver.spawn({ workerClass: "ephemeral", ttlMs: 3_600_000 }, { idempotencyKey });

/** Spawns one ephemeral worker into the given (or fresh) collaborators. */
const spawnInto = async (overrides: Partial<DriverOptions> = {}) => {
  const fake = fakeClient();
  const index = overrides.index ?? memoryFleetWorkerIndex();
  const { registrar } = fakeRegistrar();
  const driver = makeDriver({
    client: fake.client,
    settings: DEFAULT_SETTINGS,
    registrar,
    index,
    ...overrides,
  });
  const spawned = await spawnEphemeral(driver);
  return { driver, index, spawned, fake };
};

describe("OpenShellGatewayDriver.spawn", () => {
  it("uses the settings default template and a deterministic sandbox name", async () => {
    const { client, recording } = fakeClient();
    const driver = makeDriver({ client, settings: DEFAULT_SETTINGS });
    const first = await spawnEphemeral(driver);
    const second = await spawnEphemeral(driver);
    expect(recording.createCalls[0]?.template).toBe("t3-worker");
    expect(first.sandbox.name).toBe(second.sandbox.name);
    expect(first.sandbox.name).toMatch(/^t3-worker-[0-9a-f]{12}$/);
    expect(first.state).toBe("ready");
    expect(first.workerClass).toBe("ephemeral");
  });

  it("lets the per-call template override the settings default", async () => {
    const { client, recording } = fakeClient();
    const driver = makeDriver({ client, settings: DEFAULT_SETTINGS });
    await driver.spawn(
      { workerClass: "ephemeral", template: "t3-gpu" },
      { idempotencyKey: "req-2" },
    );
    expect(recording.createCalls[0]?.template).toBe("t3-gpu");
  });

  it("fails typed when no template is configured", async () => {
    const driver = makeDriver({});
    await expect(spawnEphemeral(driver)).rejects.toMatchObject({ reason: "unknown_template" });
  });

  it("labels the sandbox for the fleet and translates an explicit mode", async () => {
    const { client, recording } = fakeClient();
    const driver = makeDriver({ client, settings: DEFAULT_SETTINGS });
    await driver.spawn(
      { workerClass: "ephemeral", runtimeMode: "full-access" },
      { idempotencyKey: "req-3" },
    );
    const spec = recording.createCalls[0];
    expect(spec?.labels).toEqual({
      "t3-role": "worker",
      "t3-managed-by": "t3-fleet",
      "t3-worker-class": "ephemeral",
    });
    expect(recording.policyCalls[0]?.policy).toEqual(sandboxPolicyForRuntimeMode("full-access"));
  });

  it("applies the conservative policy default when no runtime mode is given", async () => {
    const { client, recording } = fakeClient();
    const driver = makeDriver({ client, settings: DEFAULT_SETTINGS });
    await spawnEphemeral(driver);
    expect(recording.policyCalls[0]?.policy).toEqual(
      sandboxPolicyForRuntimeMode("approval-required"),
    );
  });

  it("registers the worker and exchanges the bootstrap credential after ready", async () => {
    const { client } = fakeClient();
    const { registrar, registrations, exchanges } = fakeRegistrar();
    const index = memoryFleetWorkerIndex();
    const driver = makeDriver({
      client,
      settings: {
        defaultSandboxTemplate: "t3-worker",
        workerDefaults: { workerClass: "ephemeral", ttlMs: Duration.millis(1_800_000) },
      },
      registrar,
      index,
    });
    const result = await spawnEphemeral(driver);
    expect(result.environmentId).toBe(workerEnvId("environment-req-1"));
    expect(result.expiresAt).toBe(NOW + 3_600_000); // per-call ttlMs beats the default
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      environmentId: "environment-req-1",
      role: "worker",
      workerClass: "ephemeral",
      urls: [PAIRING_URL],
    });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.bootstrapCredential).toBe(PAIRING_CREDENTIAL);
    const row = await index.get(workerEnvId("environment-req-1"));
    expect(row?.state).toBe("ready");
    expect(row?.sandboxName).toBe(result.sandbox.name);
  });

  it("keeps the sandbox and fails typed when no registrar is configured", async () => {
    const { client, sandboxes } = fakeClient();
    const driver = new OpenShellGatewayDriver({
      client,
      settings: DEFAULT_SETTINGS,
      now: () => NOW,
    });
    await expect(spawnEphemeral(driver)).rejects.toMatchObject({ reason: "pairing" });
    expect(sandboxes.size).toBe(1); // kept for the orphan sweep to judge
  });

  it("fails typed when the worker does not report pairing material", async () => {
    const { client } = fakeClient({
      execResult: () => ({ exitCode: 1, stdout: "", stderr: "t3 not ready" }),
    });
    const driver = makeDriver({
      client,
      settings: DEFAULT_SETTINGS,
      registrar: fakeRegistrar().registrar,
    });
    await expect(spawnEphemeral(driver)).rejects.toMatchObject({ reason: "pairing" });
  });

  it("does not set a deadline on persistent workers", async () => {
    const { client } = fakeClient();
    const index = memoryFleetWorkerIndex();
    const driver = makeDriver({
      client,
      settings: DEFAULT_SETTINGS,
      registrar: fakeRegistrar().registrar,
      index,
    });
    const result = await driver.spawn(
      { workerClass: "persistent", label: "nightly-fixer" },
      { idempotencyKey: "req-4" },
    );
    expect(result.expiresAt).toBeNull();
    expect((await index.list())[0]?.label).toBe("nightly-fixer");
  });
});

describe("OpenShellGatewayDriver.remove", () => {
  it("completes only after the drain acked, then deletes the sandbox", async () => {
    const { client, recording } = fakeClient();
    const { executor, calls } = fakeExecutor();
    const index = memoryFleetWorkerIndex();
    const driver = makeDriver({
      client,
      settings: DEFAULT_SETTINGS,
      drainExecutor: executor,
      index,
    });
    const spawned = await spawnEphemeral(driver);
    const result = await driver.remove(spawned.environmentId, { idempotencyKey: "rm-1" });
    expect(result.outcome).toBe("completed");
    expect(result.sandboxOutcome).toBe("completed");
    expect(result.drain?.threads).toEqual({ total: 2, acked: 2, failed: 0 });
    expect(recording.deleteCalls).toEqual([{ name: spawned.sandbox.name, requestId: "rm-1" }]);
    expect(await index.get(spawned.environmentId)).toBeNull();
    expect(calls[0]?.drainId).toMatch(/^drain:environment-req-1:/);
  });

  it("refuses while the drain fails and keeps the sandbox", async () => {
    const { client, recording } = fakeClient();
    const { executor } = fakeExecutor({
      outcome: () => ({
        threads: { total: 2, acked: 1, failed: 1 },
        worktrees: { total: 1, acked: 0, failed: 1 },
        state: "failed",
        finishedAt: null,
      }),
    });
    const index = memoryFleetWorkerIndex();
    const driver = makeDriver({
      client,
      settings: DEFAULT_SETTINGS,
      drainExecutor: executor,
      index,
    });
    const spawned = await spawnEphemeral(driver);
    const result = await driver.remove(spawned.environmentId);
    expect(result.outcome).toBe("refused");
    expect(recording.deleteCalls).toEqual([]); // nothing lost outranks cleanup
    const row = await index.get(spawned.environmentId);
    expect(row?.state).toBe("failed");
    expect(row?.sandboxName).toBe(spawned.sandbox.name);
  });

  it("reports drain_pending on a deadline and resumes with the same drainId", async () => {
    const { client, recording } = fakeClient();
    const behavior = { hang: true };
    const { executor, calls } = fakeExecutor();
    // Wrap so the first attempt hangs until the deadline, the second answers.
    const executorOnce = {
      drain: async (input: Parameters<FleetDrainExecutor["drain"]>[0]) => {
        if (behavior.hang) return new Promise<FleetDrainOutcome>(() => {});
        return executor.drain(input);
      },
    };
    const index = memoryFleetWorkerIndex();
    const driver = makeDriver({
      client,
      settings: DEFAULT_SETTINGS,
      drainExecutor: executorOnce,
      index,
    });
    const spawned = await spawnEphemeral(driver);
    const pending = await driver.remove(spawned.environmentId, { timeoutMs: 20 });
    expect(pending.outcome).toBe("drain_pending");
    expect(recording.deleteCalls).toEqual([]);
    behavior.hang = false;
    const resumed = await driver.remove(spawned.environmentId, { timeoutMs: 5_000 });
    expect(resumed.outcome).toBe("completed");
    expect(calls.at(-1)?.drainId).toBe(calls[0]?.drainId); // section 7.4: retries reuse it
  });

  it("refuses when no drain executor is configured", async () => {
    const { client, recording } = fakeClient();
    const index = memoryFleetWorkerIndex();
    const driver = makeDriver({ client, settings: DEFAULT_SETTINGS, index });
    const spawned = await spawnEphemeral(driver);
    const result = await driver.remove(spawned.environmentId);
    expect(result.outcome).toBe("refused");
    expect(recording.deleteCalls).toEqual([]);
  });

  it("force still snapshots threads instead of the full drain", async () => {
    const { client } = fakeClient();
    const { executor, calls } = fakeExecutor();
    const driver = makeDriver({
      client,
      settings: DEFAULT_SETTINGS,
      drainExecutor: executor,
    });
    const spawned = await spawnEphemeral(driver);
    const result = await driver.remove(spawned.environmentId, { force: true });
    expect(result.outcome).toBe("completed");
    expect(calls[0]?.snapshotOnly).toBe(true);
  });

  it("keeps the row in deleting when the gateway delete fails, then replays", async () => {
    const failing = fakeClient({ deleteError: new Error("gateway unreachable") });
    const index = memoryFleetWorkerIndex();
    const driver = makeDriver({
      client: failing.client,
      settings: DEFAULT_SETTINGS,
      drainExecutor: fakeExecutor().executor,
      index,
    });
    const spawned = await spawnEphemeral(driver);
    await expect(driver.remove(spawned.environmentId)).rejects.toMatchObject({ reason: "gateway" });
    const row = await index.get(spawned.environmentId);
    expect(row?.state).toBe("deleting");
    const healthy = fakeClient();
    const retryDriver = makeDriver({
      client: healthy.client,
      settings: DEFAULT_SETTINGS,
      drainExecutor: fakeExecutor().executor,
      index,
    });
    const retried = await retryDriver.remove(spawned.environmentId, { idempotencyKey: "rm-retry" });
    expect(retried.outcome).toBe("completed");
    // Drain skipped: the journal was already complete; only the delete replayed.
    expect(healthy.recording.deleteCalls).toHaveLength(1);
  });
});

describe("OpenShellGatewayDriver.status", () => {
  it("lists workers and filters by class and id", async () => {
    const { driver, index } = await spawnInto({});
    const persistent = await driver.spawn(
      { workerClass: "persistent", label: "nightly-fixer" },
      { idempotencyKey: "req-p" },
    );
    const all = await driver.status();
    expect(all).toHaveLength(2);
    const ephemeral = await driver.status({ workerClass: "ephemeral" });
    expect(ephemeral).toHaveLength(1);
    expect(ephemeral[0]?.workerClass).toBe("ephemeral");
    const one = await driver.status({ environmentId: persistent.environmentId });
    expect(one[0]?.label).toBe("nightly-fixer");
    await index.remove(workerEnvId("environment-req-1"));
    expect(await driver.status({ environmentId: workerEnvId("environment-req-1") })).toEqual([]);
  });
});

describe("OpenShellGatewayDriver.enforceTtl", () => {
  it("releases expired ephemeral workers drain-first", async () => {
    const { client, recording } = fakeClient();
    const { executor } = fakeExecutor();
    const index = memoryFleetWorkerIndex();
    const driver = makeDriver({
      client,
      settings: DEFAULT_SETTINGS,
      drainExecutor: executor,
      index,
    });
    const expired = await spawnEphemeral(driver, "ttl-1");
    await index.upsert({
      environmentId: expired.environmentId,
      state: "ready",
      workerClass: "ephemeral",
      expiresAt: NOW - 1,
    });
    const alive = await spawnEphemeral(driver, "ttl-2");
    await index.upsert({
      environmentId: alive.environmentId,
      state: "ready",
      workerClass: "ephemeral",
      expiresAt: NOW + 60_000,
    });
    const persistent = await driver.spawn(
      { workerClass: "persistent" },
      { idempotencyKey: "ttl-3" },
    );
    const result = await driver.enforceTtl();
    expect(result.expired).toEqual([
      { environmentId: expired.environmentId, outcome: "completed" },
    ]);
    expect(recording.deleteCalls).toHaveLength(1);
    expect(await index.get(expired.environmentId)).toBeNull();
    expect(await index.get(alive.environmentId)).not.toBeNull();
    expect(await index.get(persistent.environmentId)).not.toBeNull();
  });

  it("keeps a worker whose drain refuses at the TTL deadline", async () => {
    const { client } = fakeClient();
    const { executor } = fakeExecutor({
      outcome: () => ({
        threads: { total: 1, acked: 0, failed: 1 },
        worktrees: { total: 0, acked: 0, failed: 0 },
        state: "failed",
        finishedAt: null,
      }),
    });
    const index = memoryFleetWorkerIndex();
    const driver = makeDriver({
      client,
      settings: DEFAULT_SETTINGS,
      drainExecutor: executor,
      index,
    });
    const spawned = await spawnEphemeral(driver, "ttl-4");
    await index.upsert({
      environmentId: spawned.environmentId,
      state: "ready",
      workerClass: "ephemeral",
      expiresAt: NOW - 1,
    });
    const result = await driver.enforceTtl();
    expect(result.expired).toEqual([{ environmentId: spawned.environmentId, outcome: "refused" }]);
    expect(await index.get(spawned.environmentId)).not.toBeNull();
  });
});

describe("OpenShellGatewayDriver.orphanSweep", () => {
  it("sweeps unregistered fleet sandboxes past grace and is idempotent", async () => {
    const orphan = sandboxView("t3-worker-aaaabbbbcccc", {
      labels: { "t3-role": "worker", "t3-managed-by": "t3-fleet" },
      createdAt: NOW - 60 * 60_000,
    });
    const { client, recording } = fakeClient({ sandboxes: [orphan] });
    const { registrar } = fakeRegistrar();
    const driver = makeDriver({ client, registrar, settings: DEFAULT_SETTINGS });
    const first = await driver.orphanSweep();
    expect(first.swept).toEqual([{ sandboxName: orphan.name, sandboxOutcome: "completed" }]);
    expect(recording.deleteCalls[0]?.requestId).toBe(`t3-sweep:${orphan.name}`);
    const second = await driver.orphanSweep();
    expect(second.swept).toEqual([]);
  });

  it("leaves young orphans and those without a creation time alone", async () => {
    const young = sandboxView("t3-worker-young", {
      labels: { "t3-role": "worker", "t3-managed-by": "t3-fleet" },
      createdAt: NOW - 1000,
    });
    const ageless = sandboxView("t3-worker-ageless", {
      labels: { "t3-role": "worker", "t3-managed-by": "t3-fleet" },
      createdAt: null,
    });
    const { client } = fakeClient({ sandboxes: [young, ageless] });
    const { registrar } = fakeRegistrar();
    const driver = makeDriver({ client, registrar, settings: DEFAULT_SETTINGS });
    const result = await driver.orphanSweep();
    expect(result.swept).toEqual([]);
    expect(result.leftInPlace.map((entry) => entry.name).sort()).toEqual([
      "t3-worker-ageless",
      "t3-worker-young",
    ]);
  });

  it("finalizes rows whose sandbox vanished but keeps unfinished drains", async () => {
    const gone = sandboxView("t3-worker-gone", {
      labels: { "t3-role": "worker", "t3-managed-by": "t3-fleet" },
    });
    const { client } = fakeClient({ sandboxes: [gone] });
    const index = memoryFleetWorkerIndex();
    const envVanished = workerEnvId("environment-vanished");
    const envDraining = workerEnvId("environment-draining");
    await index.upsert({
      environmentId: envVanished,
      state: "ready",
      workerClass: "ephemeral",
      sandboxName: "t3-worker-vanished",
    });
    await index.upsert({
      environmentId: envDraining,
      state: "draining",
      workerClass: "ephemeral",
      sandboxName: "t3-worker-draining",
      sandboxId: "sbx-x",
    });
    await index.setDrain(envDraining, {
      drainId: "drain:environment-draining:1",
      threads: { total: 1, acked: 0, failed: 0 },
      worktrees: { total: 0, acked: 0, failed: 0 },
      startedAt: NOW,
      finishedAt: null,
    });
    const { registrar } = fakeRegistrar();
    const driver = makeDriver({ client, registrar, index, settings: DEFAULT_SETTINGS });
    const result = await driver.orphanSweep();
    expect(result.finalized).toEqual([envVanished]);
    expect(result.leftInPlace).toEqual([
      { name: "t3-worker-gone", reason: "within orphan grace" },
      {
        name: "t3-worker-draining",
        reason: "drain unfinished; never force-delete (spec section 5.6.3)",
      },
    ]);
    expect(await index.get(envDraining)).not.toBeNull();
  });

  it("folds TTL enforcement into the sweep", async () => {
    const { client } = fakeClient();
    const { executor } = fakeExecutor();
    const index = memoryFleetWorkerIndex();
    const { registrar } = fakeRegistrar();
    const driver = makeDriver({
      client,
      registrar,
      index,
      drainExecutor: executor,
      settings: DEFAULT_SETTINGS,
    });
    const spawned = await spawnEphemeral(driver, "sweep-ttl");
    await index.upsert({
      environmentId: spawned.environmentId,
      state: "ready",
      workerClass: "ephemeral",
      expiresAt: NOW - 1,
    });
    const result = await driver.orphanSweep();
    expect(result.ttlExpired).toEqual([
      { environmentId: spawned.environmentId, outcome: "completed" },
    ]);
  });
});

describe("OpenShellGatewayDriver.drain", () => {
  it("fails the drain and keeps the sandbox when no executor exists", async () => {
    const { driver, index, spawned } = await spawnInto({});
    const result = await driver.drain(spawned.environmentId);
    expect(result.state).toBe("failed");
    expect(result.progress.threads).toEqual({ total: 0, acked: 0, failed: 0 });
    const row = await index.get(spawned.environmentId);
    expect(row?.sandboxName).not.toBeNull();
    expect(row?.state).toBe("failed");
  });
});
