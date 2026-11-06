import { describe, expect, it } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";
import {
  OpenShellFleetWorkerStatus,
  OpenShellGatewaySettings,
  OpenShellSandboxTemplate,
} from "./openshellGateway.ts";
import {
  OrchestratorMcpEnvironmentListInput,
  OrchestratorMcpEnvironmentListResult,
  OrchestratorMcpEnvironmentRemoveInput,
  OrchestratorMcpEnvironmentRemoveResult,
  OrchestratorMcpEnvironmentSpawnInput,
  OrchestratorMcpEnvironmentSpawnResult,
} from "./orchestratorMcp.ts";

const decodeGatewaySettings = Schema.decodeUnknownSync(OpenShellGatewaySettings);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeSpawnInput = Schema.decodeUnknownSync(OrchestratorMcpEnvironmentSpawnInput);
const decodeSpawnResult = Schema.decodeUnknownSync(OrchestratorMcpEnvironmentSpawnResult);
const decodeRemoveInput = Schema.decodeUnknownSync(OrchestratorMcpEnvironmentRemoveInput);
const decodeRemoveResult = Schema.decodeUnknownSync(OrchestratorMcpEnvironmentRemoveResult);
const decodeListInput = Schema.decodeUnknownSync(OrchestratorMcpEnvironmentListInput);
const decodeListResult = Schema.decodeUnknownSync(OrchestratorMcpEnvironmentListResult);
const decodeWorkerStatus = Schema.decodeUnknownSync(OpenShellFleetWorkerStatus);
const decodeTemplate = Schema.decodeUnknownSync(OpenShellSandboxTemplate);

// RFC-2606 example address; the contract only cares that it is a non-empty URL string.
const gatewaySettings = {
  gatewayUrl: "https://openshell.example.com",
  defaultSandboxTemplate: "t3-worker",
  managingInstance: true,
  workerDefaults: {
    workerClass: "ephemeral",
    ttlMs: 86_400_000,
    idleTimeoutMs: 1_800_000,
    drainTimeoutMs: 600_000,
    resources: { cpu: "2", memory: "4Gi", gpu: 0 },
  },
  sharedCache: { enabled: true, mode: "rwx-pvc", pvcNames: { cache: "t3-cache" } },
} as const;

describe("OpenShellGatewaySettings", () => {
  it("decodes empty settings to safe defaults", () => {
    const settings = decodeGatewaySettings({});
    expect(settings.driver).toBe("openshell");
    expect(settings.managingInstance).toBe(false);
    expect(settings.gatewayUrl).toBeUndefined();
    expect(settings.credential).toBeUndefined();
    expect(settings.workerDefaults).toBeUndefined();
    expect(settings.sharedCache).toBeUndefined();
  });

  it("decodes a full managing-instance config", () => {
    const settings = decodeGatewaySettings({
      ...gatewaySettings,
      credential: null,
    });
    expect(settings.gatewayUrl).toBe("https://openshell.example.com");
    expect(settings.defaultSandboxTemplate).toBe("t3-worker");
    expect(settings.managingInstance).toBe(true);
    expect(settings.credential).toBeNull();
    const { workerDefaults, sharedCache } = settings;
    if (!workerDefaults || !sharedCache) throw new Error("expected defaults to decode");
    if (!workerDefaults.ttlMs || !workerDefaults.idleTimeoutMs) {
      throw new Error("expected worker TTLs to decode");
    }
    expect(Duration.toMillis(workerDefaults.ttlMs)).toBe(86_400_000);
    expect(Duration.toMillis(workerDefaults.idleTimeoutMs)).toBe(1_800_000);
    if (!workerDefaults.resources) throw new Error("expected resources to decode");
    expect(workerDefaults.resources.cpu).toBe("2");
    expect(sharedCache.mode).toBe("rwx-pvc");
    expect(sharedCache.mountPath).toBe("/opt/t3cache");
  });

  it("decodes a secret-provider credential reference without secret bytes", () => {
    const settings = decodeGatewaySettings({
      ...gatewaySettings,
      credential: { provider: "onepassword", reference: "openshell/gateway" },
    });
    expect(settings.credential).toEqual({
      provider: "onepassword",
      reference: "openshell/gateway",
    });
  });

  it("rejects a credential without a provider and unknown worker classes", () => {
    expect(() =>
      decodeGatewaySettings({ ...gatewaySettings, credential: { reference: "x" } }),
    ).toThrow();
    expect(() =>
      decodeGatewaySettings({ ...gatewaySettings, workerDefaults: { workerClass: "spot" } }),
    ).toThrow();
  });

  it("round-trips through ServerSettings defaults and patch", () => {
    const defaults = decodeServerSettings({});
    expect(defaults.openshellEnabled).toBe(false);
    expect(defaults.openshell.driver).toBe("openshell");
    expect(defaults.openshell.managingInstance).toBe(false);

    const patched = decodeServerSettingsPatch({
      openshellEnabled: true,
      openshell: { gatewayUrl: "https://openshell.example.com", managingInstance: true },
    });
    expect(patched.openshellEnabled).toBe(true);
    const patchedOpenshell = patched.openshell;
    if (!patchedOpenshell) throw new Error("expected openshell settings to decode");
    expect(patchedOpenshell.gatewayUrl).toBe("https://openshell.example.com");
    expect(patchedOpenshell.managingInstance).toBe(true);
  });
});

describe("OrchestratorMcpEnvironmentSpawnInput", () => {
  it("defaults the worker class and keeps idempotency keys", () => {
    const input = decodeSpawnInput({ clientRequestId: "req-1" });
    expect(input.workerClass).toBe("ephemeral");
    expect(input.clientRequestId).toBe("req-1");
  });

  it("decodes template, ttl, seed and persistent class", () => {
    const input = decodeSpawnInput({
      template: "t3-worker",
      workerClass: "persistent",
      label: "nightly-fixer",
      ttlMs: 3_600_000,
      seedFrom: "refs/heads/t3/task-42",
    });
    expect(input.template).toBe("t3-worker");
    expect(input.workerClass).toBe("persistent");
    expect(input.label).toBe("nightly-fixer");
    if (!input.ttlMs) throw new Error("expected ttl to decode");
    expect(Duration.toMillis(input.ttlMs)).toBe(3_600_000);
    expect(input.seedFrom).toBe("refs/heads/t3/task-42");
  });

  it("rejects an unknown worker class", () => {
    expect(() => decodeSpawnInput({ workerClass: "warm" })).toThrow();
  });
});

describe("OrchestratorMcpEnvironmentSpawnResult", () => {
  const result = {
    environmentId: "environment-worker-1",
    sandbox: {
      name: "t3-worker-9f2c",
      sandboxId: "sbx-1",
      template: "t3-worker",
      phase: "Ready",
    },
    workerClass: "ephemeral",
    state: "ready",
    expiresAt: 1_800_000,
    warnings: [],
  } as const;

  it("decodes a ready worker", () => {
    expect(decodeSpawnResult(result).environmentId).toBe("environment-worker-1");
    expect(decodeSpawnResult(result).sandbox.sandboxId).toBe("sbx-1");
  });

  it("decodes a null template and expiry", () => {
    expect(
      decodeSpawnResult({
        ...result,
        sandbox: { ...result.sandbox, template: null },
        expiresAt: null,
      }).expiresAt,
    ).toBeNull();
  });

  it("rejects fleet states outside the contract", () => {
    expect(() => decodeSpawnResult({ ...result, state: "stopped" })).toThrow();
    expect(() => decodeSpawnResult({ ...result, state: "drain_failed" })).toThrow();
  });
});

describe("OrchestratorMcpEnvironmentRemoveInput", () => {
  it("takes a plain target id with optional drain overrides", () => {
    const input = decodeRemoveInput({
      targetEnvironmentId: "environment-worker-1",
      drainTimeoutMs: 600_000,
      force: false,
    });
    expect(input.targetEnvironmentId).toBe("environment-worker-1");
    if (!input.drainTimeoutMs) throw new Error("expected drain timeout to decode");
    expect(Duration.toMillis(input.drainTimeoutMs)).toBe(600_000);
    expect(input.force).toBe(false);
  });

  it("requires the target", () => {
    expect(() => decodeRemoveInput({})).toThrow();
  });
});

describe("OrchestratorMcpEnvironmentRemoveResult", () => {
  const drain = {
    drainId: "drain:environment-worker-1:1",
    threads: { total: 3, acked: 3, failed: 0 },
    worktrees: { total: 1, acked: 1, failed: 0 },
    startedAt: 1,
    finishedAt: 2,
  };

  it("decodes completed, pending and refused outcomes", () => {
    expect(
      decodeRemoveResult({
        targetEnvironmentId: "environment-worker-1",
        outcome: "completed",
        sandboxOutcome: "already_absent",
      }).outcome,
    ).toBe("completed");
    const pending = decodeRemoveResult({
      targetEnvironmentId: "environment-worker-1",
      outcome: "drain_pending",
      drain: { ...drain, finishedAt: null },
    });
    if (!pending.drain) throw new Error("expected drain progress to decode");
    expect(pending.drain.finishedAt).toBeNull();
    const refused = decodeRemoveResult({
      targetEnvironmentId: "environment-worker-1",
      outcome: "refused",
      drain,
      reason: "drain_timeout",
    });
    expect(refused.reason).toBe("drain_timeout");
    if (!refused.drain) throw new Error("expected drain progress to decode");
    expect(refused.drain.threads.acked).toBe(3);
  });

  it("rejects unknown outcomes and sandbox outcomes", () => {
    expect(() =>
      decodeRemoveResult({ targetEnvironmentId: "environment-worker-1", outcome: "deleted" }),
    ).toThrow();
    expect(() =>
      decodeRemoveResult({
        targetEnvironmentId: "environment-worker-1",
        outcome: "completed",
        sandboxOutcome: "maybe",
      }),
    ).toThrow();
  });
});

describe("OrchestratorMcpEnvironmentList", () => {
  it("filters by worker class", () => {
    expect(decodeListInput({}).workerClass).toBeUndefined();
    expect(decodeListInput({ workerClass: "persistent" }).workerClass).toBe("persistent");
    expect(() => decodeListInput({ workerClass: "warm" })).toThrow();
  });

  it("decodes worker rows and rejects invalid states", () => {
    const result = decodeListResult({
      workers: [
        {
          environmentId: "environment-worker-1",
          label: null,
          sandboxName: "t3-worker-9f2c",
          workerClass: "ephemeral",
          state: "ready",
          expiresAt: null,
          lastError: null,
        },
      ],
    });
    expect(result.workers).toHaveLength(1);
    const worker = result.workers[0];
    if (!worker) throw new Error("expected one worker row");
    expect(worker.state).toBe("ready");

    expect(() =>
      decodeWorkerStatus({
        environmentId: "environment-worker-1",
        label: null,
        sandboxName: "t3-worker-9f2c",
        workerClass: "ephemeral",
        state: "warm",
        expiresAt: null,
        lastError: null,
      }),
    ).toThrow();
  });
});

describe("OpenShellSandboxTemplate", () => {
  it("decodes name only and a full worker template", () => {
    expect(decodeTemplate({ name: "t3-worker" }).name).toBe("t3-worker");
    const template = decodeTemplate({
      name: "t3-worker",
      image: "registry.example.com/org/t3-agent:1.0",
      cpu: "2",
      memory: "4Gi",
      role: "worker",
    });
    expect(template.role).toBe("worker");
  });

  it("rejects unknown roles and empty names", () => {
    expect(() => decodeTemplate({ name: "t3-worker", role: "cache" })).toThrow();
    expect(() => decodeTemplate({ name: " " })).toThrow();
  });
});
