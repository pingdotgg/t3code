import { describe, expect, test } from "bun:test";
import { Sandbox } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";

import { JEVIN_AI_SNAPSHOT_NAME } from "../snapshot";
import {
  buildSandboxCreateParams,
  makeSandboxService,
  resolveSandboxVolumeMount,
  validateSandboxMountPath,
} from "./sandbox.layer";

function createFakeSandboxHarness(
  id: string,
  options?: {
    readonly state?: string;
    readonly errorReason?: string;
    readonly probeResult?: {
      readonly exitCode: number;
      readonly result: string;
    };
    readonly probeError?: unknown;
  },
): {
  readonly sandbox: Sandbox;
  readonly probeCalls: Array<{
    readonly command: string;
    readonly cwd: string | undefined;
    readonly timeout: number | undefined;
  }>;
  readonly startCalls: number[];
  readonly stopCalls: number[];
} {
  const sandbox = Object.create(Sandbox.prototype);
  const probeCalls: Array<{
    readonly command: string;
    readonly cwd: string | undefined;
    readonly timeout: number | undefined;
  }> = [];
  const startCalls: number[] = [];
  const stopCalls: number[] = [];
  sandbox.id = id;
  sandbox.state = options?.state ?? "started";
  sandbox.errorReason = options?.errorReason;
  sandbox.process = {
    executeCommand: async (
      command: string,
      cwd?: string,
      _env?: Record<string, string>,
      timeout?: number,
    ) => {
      probeCalls.push({
        command,
        cwd,
        timeout,
      });

      if (options?.probeError) {
        throw options.probeError;
      }

      return {
        exitCode: options?.probeResult?.exitCode ?? 0,
        result: options?.probeResult?.result ?? "__jevin_sandbox_healthcheck_ok__",
        artifacts: {
          stdout: options?.probeResult?.result ?? "__jevin_sandbox_healthcheck_ok__",
        },
      };
    },
  };
  sandbox.start = async (timeout?: number) => {
    startCalls.push(timeout ?? 0);
    sandbox.state = "started";
  };
  sandbox.stop = async (timeout?: number) => {
    stopCalls.push(timeout ?? 0);
    sandbox.state = "stopped";
  };
  sandbox.refreshData = async () => {};

  return {
    sandbox,
    probeCalls,
    startCalls,
    stopCalls,
  };
}

function createSandboxClient(options?: {
  readonly snapshots?: ReadonlyArray<{ readonly name: string }>;
  readonly createError?: unknown;
  readonly lookupError?: unknown;
  readonly deleteError?: unknown;
  readonly sandbox?: Sandbox;
}) {
  const createCalls: Array<{
    readonly params: Record<string, unknown>;
    readonly timeout: number | undefined;
  }> = [];
  const deleteCalls: string[] = [];

  const sandbox = options?.sandbox ?? createFakeSandboxHarness("sbx_test").sandbox;

  return {
    createCalls,
    deleteCalls,
    client: {
      snapshot: {
        list: async () => ({
          items: options?.snapshots ?? [],
        }),
      },
      create: async (
        params: Record<string, unknown>,
        createOptions?: {
          readonly timeout?: number;
        },
      ) => {
        createCalls.push({
          params,
          timeout: createOptions?.timeout,
        });

        if (options?.createError) {
          throw options.createError;
        }

        return sandbox;
      },
      get: async (sandboxId: string) => {
        if (options?.lookupError) {
          throw options.lookupError;
        }

        const target = options?.sandbox ?? createFakeSandboxHarness(sandboxId).sandbox;
        target.id = sandboxId;
        return target;
      },
      delete: async (targetSandbox: Sandbox) => {
        deleteCalls.push(targetSandbox.id);

        if (options?.deleteError) {
          throw options.deleteError;
        }
      },
    },
  };
}

describe("sandbox mount validation", () => {
  test("accepts an absolute mount path", async () => {
    await expect(Effect.runPromise(validateSandboxMountPath("/workspace/cache"))).resolves.toBe(
      "/workspace/cache",
    );
  });

  test("rejects root and relative mount paths", async () => {
    await expect(Effect.runPromise(validateSandboxMountPath("/"))).rejects.toMatchObject({
      mountPath: "/",
    });

    await expect(
      Effect.runPromise(validateSandboxMountPath("workspace/cache")),
    ).rejects.toMatchObject({
      mountPath: "workspace/cache",
    });
  });

  test("defaults the volume mount path and preserves subpath", async () => {
    await expect(
      Effect.runPromise(
        resolveSandboxVolumeMount(
          {
            volume: {
              volumeId: "vol_123",
              subpath: "org-42",
            },
          },
          "/workspace",
        ),
      ),
    ).resolves.toEqual({
      volumeId: "vol_123",
      mountPath: "/workspace",
      subpath: "org-42",
    });
  });
});

describe("buildSandboxCreateParams", () => {
  test("builds snapshot params with the default jevin label set", () => {
    expect(
      buildSandboxCreateParams(
        {
          sandboxName: "demo",
          labels: {
            capability: "terminal",
          },
        },
        undefined,
        15,
        true,
      ),
    ).toMatchObject({
      name: "demo",
      user: "daytona",
      snapshot: JEVIN_AI_SNAPSHOT_NAME,
      autoStopInterval: 15,
      labels: {
        app: "jevin-ai",
        capability: "terminal",
      },
      ephemeral: false,
    });
  });
});

describe("makeSandboxService", () => {
  test("creates a sandbox from the snapshot when it exists", async () => {
    const { client, createCalls } = createSandboxClient({
      snapshots: [{ name: JEVIN_AI_SNAPSHOT_NAME }],
    });
    const service = makeSandboxService({
      client,
      autoStopInterval: 45,
      defaultMountPath: "/workspace",
    });

    const sandbox = await Effect.runPromise(
      service.createSandbox({
        sandboxName: "jevin-demo",
        volume: {
          volumeId: "vol_123",
        },
        labels: {
          capability: "git",
        },
      }),
    );

    expect(sandbox.id).toBe("sbx_test");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      timeout: undefined,
      params: {
        name: "jevin-demo",
        snapshot: JEVIN_AI_SNAPSHOT_NAME,
        autoStopInterval: 45,
        labels: {
          app: "jevin-ai",
          capability: "git",
        },
        volumes: [
          {
            volumeId: "vol_123",
            mountPath: "/workspace",
          },
        ],
      },
    });
  });

  test("falls back to the image when the snapshot does not exist", async () => {
    const { client, createCalls } = createSandboxClient();
    const service = makeSandboxService({
      client,
      autoStopInterval: 15,
      defaultMountPath: "/workspace",
    });

    await Effect.runPromise(
      service.createSandbox({
        timeoutSeconds: 90,
      }),
    );

    expect(createCalls[0]?.timeout).toBe(90);
    expect(createCalls[0]?.params.image).toBeDefined();
    expect(createCalls[0]?.params.snapshot).toBeUndefined();
  });

  test("maps lookup and delete failures to typed errors", async () => {
    const service = makeSandboxService({
      client: createSandboxClient({
        lookupError: new Error("missing"),
      }).client,
      autoStopInterval: 15,
      defaultMountPath: "/workspace",
    });

    await expect(Effect.runPromise(service.getSandbox("sbx_missing"))).rejects.toMatchObject({
      _tag: "ManagedSandboxLookupError",
      sandboxId: "sbx_missing",
    });

    const deleteService = makeSandboxService({
      client: createSandboxClient({
        deleteError: new Error("boom"),
      }).client,
      autoStopInterval: 15,
      defaultMountPath: "/workspace",
    });

    await expect(
      Effect.runPromise(
        deleteService.deleteSandbox(createFakeSandboxHarness("sbx_delete").sandbox),
      ),
    ).rejects.toMatchObject({
      _tag: "ManagedSandboxDeleteError",
      sandboxId: "sbx_delete",
    });
  });

  test("delegates start and stop to the Daytona sandbox", async () => {
    const harness = createFakeSandboxHarness("sbx_lifecycle", {
      state: "stopped",
    });
    const service = makeSandboxService({
      client: createSandboxClient({
        sandbox: harness.sandbox,
      }).client,
      autoStopInterval: 15,
      defaultMountPath: "/workspace",
    });

    const started = await Effect.runPromise(
      service.startSandbox("sbx_lifecycle", {
        timeoutSeconds: 42,
      }),
    );

    expect(started.state).toBe("started");
    expect(harness.startCalls).toEqual([42]);

    const stopped = await Effect.runPromise(
      service.stopSandbox(started, {
        timeoutSeconds: 24,
      }),
    );

    expect(stopped.state).toBe("stopped");
    expect(harness.stopCalls).toEqual([24]);
  });

  test("maps Daytona lifecycle states before probing", async () => {
    const harness = createFakeSandboxHarness("sbx_creating", {
      state: "creating",
    });
    const service = makeSandboxService({
      client: createSandboxClient({
        sandbox: harness.sandbox,
      }).client,
      autoStopInterval: 15,
      defaultMountPath: "/workspace",
    });

    const result = await Effect.runPromise(service.checkSandboxHealth("sbx_creating"));

    expect(result.lifecycleStatus).toBe("creating");
    expect(result.healthStatus).toBe("unknown");
    expect(harness.probeCalls).toHaveLength(0);
  });

  test("reports a healthy sandbox when the probe succeeds", async () => {
    const harness = createFakeSandboxHarness("sbx_ready");
    const service = makeSandboxService({
      client: createSandboxClient({
        sandbox: harness.sandbox,
      }).client,
      autoStopInterval: 15,
      defaultMountPath: "/workspace",
    });

    const result = await Effect.runPromise(
      service.checkSandboxHealth("sbx_ready", {
        timeoutSeconds: 7,
      }),
    );

    expect(result.lifecycleStatus).toBe("ready");
    expect(result.healthStatus).toBe("healthy");
    expect(result.message).toBeNull();
    expect(harness.probeCalls).toEqual([
      {
        command: "test -d '/workspace' && printf '__jevin_sandbox_healthcheck_ok__'",
        cwd: "/workspace",
        timeout: 7,
      },
    ]);
  });

  test("reports an unhealthy sandbox when the probe fails", async () => {
    const harness = createFakeSandboxHarness("sbx_unhealthy", {
      probeResult: {
        exitCode: 1,
        result: "missing mount",
      },
    });
    const service = makeSandboxService({
      client: createSandboxClient({
        sandbox: harness.sandbox,
      }).client,
      autoStopInterval: 15,
      defaultMountPath: "/workspace",
    });

    const result = await Effect.runPromise(service.checkSandboxHealth("sbx_unhealthy"));

    expect(result.lifecycleStatus).toBe("error");
    expect(result.healthStatus).toBe("unhealthy");
    expect(result.message).toBe("missing mount");
  });

  test("maps lookup failures during health checks to typed errors", async () => {
    const service = makeSandboxService({
      client: createSandboxClient({
        lookupError: new Error("missing"),
      }).client,
      autoStopInterval: 15,
      defaultMountPath: "/workspace",
    });

    await expect(
      Effect.runPromise(service.checkSandboxHealth("sbx_missing")),
    ).rejects.toMatchObject({
      _tag: "ManagedSandboxLookupError",
      sandboxId: "sbx_missing",
    });
  });
});
