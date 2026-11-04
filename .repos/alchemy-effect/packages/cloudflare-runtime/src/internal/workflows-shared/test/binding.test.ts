// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Alchemy modifications: expects Effect Schema validation messages and cloudflare-runtime Workflow storage paths.
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { describe, it, vi } from "vitest";
import { deleteWorkflowStorage, WorkflowBinding } from "../binding.ts";
import type { WorkflowBatchCreateOptions, WorkflowHandle } from "../binding.ts";
import type { Engine, EngineLogs } from "../engine.ts";
import { InstanceEvent, InstanceStatus } from "../index.ts";
import { WorkflowSubscriptionTarget } from "../subscription.ts";
import type { WorkflowSubscription, WorkflowSubscriptionEvent } from "../subscription.ts";
import { setTestWorkflowCallback } from "./test-entry.ts";

let instanceCounter = 0;
function uniqueId(prefix = "instance"): string {
  return `${prefix}-${++instanceCounter}`;
}

function createBinding(): WorkflowBinding {
  const ctx = createExecutionContext();
  return new WorkflowBinding(ctx, {
    ENGINE: env.ENGINE,
    BINDING_NAME: "TEST_WORKFLOW",
    WORKFLOW_NAME: "test-workflow",
  });
}

async function waitUntilLogEvent(
  engineStub: DurableObjectStub<Engine>,
  event: InstanceEvent,
  timeout = 5000,
): Promise<void> {
  await vi.waitUntil(
    async () => {
      const logs = (await engineStub.readLogs()) as EngineLogs;
      const hasEvent = logs.logs.some((log) => log.event === event);
      return hasEvent;
    },
    { timeout },
  );
}

describe("WorkflowBinding", () => {
  describe("create()", () => {
    it("should create an instance with provided id and params", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (event) => {
        return (event as WorkflowEvent<{ key: string }>).payload;
      });

      const params = { key: "test-value" };
      const result = await binding.create({ id, params });

      expect(result.id).toBe(id);

      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      const instance = await binding.get(id);
      const status = await instance.status();
      expect(status.output).toEqual(params);
    });

    it("should pass the workflow name in the event", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (event) => {
        return (event as WorkflowEvent<unknown>).workflowName;
      });

      await binding.create({ id });

      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      const instance = await binding.get(id);
      const status = await instance.status();
      expect(status.output).toBe("test-workflow");
    });

    it("should auto-generate id when not provided", async ({ expect }) => {
      const binding = createBinding();
      setTestWorkflowCallback(async () => "done");
      const result = await binding.create();

      expect(result.id).toBeDefined();
      expect(result.id.length).toBeGreaterThan(0);

      // Wait for the workflow to complete before the test ends so
      // the fire-and-forget init() RPC settles before teardown.
      const instance = await binding.get(result.id);
      await vi.waitUntil(
        async () => {
          const s = await instance.status();
          return s.status === "complete";
        },
        { timeout: 5000 },
      );
    });

    it("should throw WorkflowError for invalid instance id", async ({ expect }) => {
      const binding = createBinding();
      await expect(binding.create({ id: "#invalid!" })).rejects.toThrow(
        "Workflow instance has invalid id",
      );
    });

    it("should reject a null id instead of generating one", async ({ expect }) => {
      const binding = createBinding();
      await expect(binding.create({ id: null as unknown as string })).rejects.toThrow(
        "Workflow instance has invalid id",
      );
    });

    for (const method of ["create", "createBatch"] as const) {
      it(`${method} should retry failed cleanup before reusing an instance ID`, async ({
        expect,
      }) => {
        const id = uniqueId("cleanup-failed");
        const ctx = createExecutionContext();
        const abort = vi.fn(async () => {});
        const diskFetch = vi.fn((_url: string, _init?: RequestInit) =>
          Promise.resolve(
            new Response(null, {
              headers: { "Content-Type": "application/json" },
            }),
          ),
        );
        const storageEnv = {
          ENGINE: env.ENGINE,
          BINDING_NAME: "TEST_WORKFLOW",
          WORKFLOW_NAME: "test-workflow",
          WORKFLOW_STORAGE: { fetch: diskFetch } as unknown as Fetcher,
        };
        const binding = new WorkflowBinding(ctx, storageEnv);
        const deletionError = "Refusing to delete a Workflow storage directory";
        await expect(
          deleteWorkflowStorage({
            disk: storageEnv.WORKFLOW_STORAGE,
            workflowName: storageEnv.WORKFLOW_NAME,
            ctx,
            hexId: env.ENGINE.idFromName(id).toString(),
            abort,
          }),
        ).rejects.toThrow(deletionError);

        await expect(
          deleteWorkflowStorage({
            disk: storageEnv.WORKFLOW_STORAGE,
            workflowName: storageEnv.WORKFLOW_NAME,
            ctx,
            hexId: env.ENGINE.idFromName(id).toString(),
            abort: async () => {
              throw new Error("instance.not_found");
            },
          }),
        ).rejects.toThrow("instance.not_found");

        diskFetch.mockClear();
        await expect(
          method === "create" ? binding.create({ id }) : binding.createBatch([{ id }]),
        ).rejects.toThrow(deletionError);
        expect(diskFetch.mock.calls.filter(([url]) => url.endsWith(".sqlite"))).toHaveLength(1);
        await expect(waitOnExecutionContext(ctx)).resolves.toBeUndefined();

        diskFetch.mockImplementation((_url, init) =>
          Promise.resolve(
            new Response(null, {
              status: init?.method === "DELETE" ? 204 : 200,
              headers: { "Content-Type": "application/octet-stream" },
            }),
          ),
        );
        setTestWorkflowCallback(async () => "done");
        const freshBinding = new WorkflowBinding(ctx, storageEnv);
        await expect(
          method === "create" ? freshBinding.create({ id }) : freshBinding.createBatch([{ id }]),
        ).resolves.toEqual(method === "create" ? { id } : [{ id }]);
        expect(diskFetch).toHaveBeenCalledWith(expect.stringMatching(/\.sqlite$/), {
          method: "DELETE",
        });
        expect(abort).toHaveBeenCalledOnce();
        await waitUntilLogEvent(
          env.ENGINE.get(env.ENGINE.idFromName(id)),
          InstanceEvent.WORKFLOW_SUCCESS,
        );
        await waitOnExecutionContext(ctx);
      });
    }
  });

  describe("get()", () => {
    it("should return a WorkflowHandle for an existing instance", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async () => "done");
      await binding.create({ id });

      const instance = await binding.get(id);

      expect(instance).toMatchObject({
        id,
        status: expect.any(Function),
        pause: expect.any(Function),
        resume: expect.any(Function),
        terminate: expect.any(Function),
        restart: expect.any(Function),
        delete: expect.any(Function),
      });

      // Wait for the workflow to complete before the test ends so
      // the fire-and-forget init() RPC settles before teardown.
      await vi.waitUntil(
        async () => {
          const s = await instance.status();
          return s.status === "complete";
        },
        { timeout: 5000 },
      );
    });
  });

  describe("instance deletion", () => {
    it("deleteInstance should delete an instance and wipe its stored state", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();

      setTestWorkflowCallback(async () => "done");
      await binding.create({ id });

      const instance = await binding.get(id);
      await vi.waitUntil(
        async () => {
          const status = await instance.status();
          return status.status === "complete";
        },
        { timeout: 5000 },
      );

      await expect(binding.deleteInstance(id)).resolves.toBeUndefined();
      await expect(binding.get(id)).rejects.toThrow("instance.not_found");
    });

    it("should reject an invalid instance ID", async ({ expect }) => {
      await expect(createBinding().deleteInstance("")).rejects.toThrow(
        "(instance.invalid_id) Instance ID is invalid",
      );
    });

    it("should accept a cron-generated instance ID", async ({ expect }) => {
      await expect(createBinding().deleteInstance("*/30 * * * *-1786001400000")).rejects.toThrow(
        "instance.not_found",
      );
    });

    it("should let a running instance delete itself and stop execution", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      let deleteStarted = false;
      let continuedAfterDelete = false;

      setTestWorkflowCallback(async () => {
        deleteStarted = true;
        const instance = await binding.get(id);
        await (instance as unknown as { delete(): Promise<void> }).delete();
        continuedAfterDelete = true;
      });
      await binding.create({ id });
      await vi.waitUntil(() => deleteStarted, { timeout: 5000 });

      await vi.waitUntil(
        async () => {
          try {
            await binding.get(id);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 5000 },
      );

      await scheduler.wait(50);
      expect(continuedAfterDelete).toBe(false);
      await expect(binding.get(id)).rejects.toThrow("instance.not_found");
    });
  });

  describe("deleteBatch()", () => {
    it("should delete instances and wipe their stored state", async ({ expect }) => {
      const ids = [uniqueId(), uniqueId()];
      const binding = createBinding();

      setTestWorkflowCallback(async () => "done");
      await binding.createBatch(ids.map((id) => ({ id })));

      for (const id of ids) {
        const instance = await binding.get(id);
        await vi.waitUntil(
          async () => {
            const status = await instance.status();
            return status.status === "complete";
          },
          { timeout: 5000 },
        );
      }

      await expect(binding.deleteBatch({ instances: ids })).resolves.toEqual({
        deleted: ids.map((id) => ({ id })),
        errors: [],
      });
      for (const id of ids) {
        await expect(binding.get(id)).rejects.toThrow("instance.not_found");
      }
    });

    it("should report each duplicate missing cron-generated ID", async ({ expect }) => {
      const binding = createBinding();
      const cronId = "*/30 * * * *-1786001400000";
      await expect(
        binding.deleteBatch({
          instances: [cronId, cronId],
        }),
      ).resolves.toEqual({
        deleted: [],
        errors: [
          {
            id: cronId,
            code: 10400,
            message: "workflows.api.error.instance.not_found",
          },
          {
            id: cronId,
            code: 10400,
            message: "workflows.api.error.instance.not_found",
          },
        ],
      });
    });

    it("should normalize unexpected deletion errors", async ({ expect }) => {
      const deleteInstance = vi.fn().mockRejectedValue(new Error("sensitive failure"));
      const binding = new WorkflowBinding(createExecutionContext(), {
        ENGINE: {
          idFromName: (id: string) => env.ENGINE.idFromName(id),
          get: (id: DurableObjectId) => ({ id, deleteInstance }),
        } as unknown as DurableObjectNamespace<Engine>,
        BINDING_NAME: "TEST_WORKFLOW",
        WORKFLOW_NAME: "test-workflow",
      });

      await expect(binding.deleteBatch({ instances: ["broken-instance"] })).resolves.toEqual({
        deleted: [],
        errors: [
          {
            id: "broken-instance",
            code: 10001,
            message: "workflows.api.error.internal_server",
          },
        ],
      });
      expect(deleteInstance).toHaveBeenCalledOnce();
    });

    it("should report persistence cleanup failures per instance", async ({ expect }) => {
      const abort = vi.fn(() => Promise.reject(new Error("Durable Object aborted")));
      const cleanupFailedId = env.ENGINE.idFromName("cleanup-failed").toString();
      const missingId = env.ENGINE.idFromName("missing").toString();
      const ctx = createExecutionContext();
      const diskFetch = vi.fn((url: string, init?: RequestInit) =>
        Promise.resolve(
          new Response(null, {
            status:
              url.includes(cleanupFailedId) && url.endsWith(".sqlite")
                ? init?.method === "HEAD"
                  ? 200
                  : 500
                : 404,
            headers: { "Content-Type": "application/octet-stream" },
          }),
        ),
      );
      const binding = new WorkflowBinding(ctx, {
        ENGINE: {
          idFromName: (id: string) => env.ENGINE.idFromName(id),
          get: (id: DurableObjectId) => ({
            id,
            deleteInstance: () => {
              if (id.toString() === missingId) {
                return Promise.reject(new Error("(instance.not_found) Instance does not exist"));
              }
              return Promise.resolve();
            },
            unsafeAbort: abort,
          }),
        } as unknown as DurableObjectNamespace<Engine>,
        BINDING_NAME: "TEST_WORKFLOW",
        WORKFLOW_NAME: "test-workflow",
        WORKFLOW_STORAGE: { fetch: diskFetch } as unknown as Fetcher,
      });

      await expect(
        binding.deleteBatch({
          instances: ["cleanup-failed", "missing", "deleted", "cleanup-failed"],
        }),
      ).resolves.toEqual({
        deleted: [{ id: "deleted" }],
        errors: [
          {
            id: "cleanup-failed",
            code: 10001,
            message: "workflows.api.error.internal_server",
          },
          {
            id: "missing",
            code: 10400,
            message: "workflows.api.error.instance.not_found",
          },
          {
            id: "cleanup-failed",
            code: 10001,
            message: "workflows.api.error.internal_server",
          },
        ],
      });
      expect(abort).toHaveBeenCalledOnce();
      expect(diskFetch).toHaveBeenCalledWith(`http://disk/test-workflow/${missingId}.sqlite`, {
        method: "HEAD",
      });
      await expect(waitOnExecutionContext(ctx)).resolves.toBeUndefined();
    });

    it("should reject invalid batches", async ({ expect }) => {
      const binding = createBinding();
      await expect(binding.deleteBatch({ instances: [] })).rejects.toThrow(
        "(body) batchDeleteInstances should have at least 1 instance",
      );
      await expect(
        binding.deleteBatch({
          instances: Array.from({ length: 101 }, (_, i) => `instance-${i}`),
        }),
      ).rejects.toThrow("(body) batchDeleteInstances only supports 100 instances at a time");
      await expect(binding.deleteBatch({ instances: [""] })).rejects.toThrow(
        "(instance.invalid_id) Instance ID is invalid",
      );
    });
  });

  describe("createBatch()", () => {
    it("should create multiple instances in a batch", async ({ expect }) => {
      const binding = createBinding();
      // Unique per attempt: createBatch() skips existing IDs, so fixed IDs would
      // make a vitest retry return [] after a failed first attempt.
      const ids = [1, 2, 3].map((n) => uniqueId(`batch-${n}`));
      setTestWorkflowCallback(async () => "done");

      const results = await binding.createBatch(ids.map((id) => ({ id })));

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.id)).toEqual(ids);

      for (const id of ids) {
        const instance = await binding.get(id);
        expect(instance.id).toBe(id);
      }

      // Wait for all batch workflows to complete before the test ends
      // so the fire-and-forget init() RPCs settle before teardown.
      for (const id of ids) {
        const instance = await binding.get(id);
        await vi.waitUntil(
          async () => {
            const s = await instance.status();
            return s.status === "complete";
          },
          { timeout: 5000 },
        );
      }
    });

    it("should create instances by count with shared options", async ({ expect }) => {
      const binding = createBinding();
      const params = { source: "count" };
      setTestWorkflowCallback(async (event) => (event as WorkflowEvent<typeof params>).payload);

      const result = await binding.createBatch({
        count: 2,
        params,
        retention: { successRetention: "1 day" },
        locationHint: "weur",
      });

      expect(result.errors).toEqual([]);
      expect(result.created).toHaveLength(2);
      expect(result.created[0].id).not.toBe(result.created[1].id);

      for (const { id } of result.created) {
        const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));
        await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);
        const instance = await binding.get(id);
        expect((await instance.status()).output).toEqual(params);
      }
    });

    it("should report per-instance errors for duplicate ids", async ({ expect }) => {
      const binding = createBinding();
      const existing = uniqueId("batch-existing");
      const fresh = uniqueId("batch-fresh");
      setTestWorkflowCallback(async () => "done");

      await binding.create({ id: existing });
      await waitUntilLogEvent(
        env.ENGINE.get(env.ENGINE.idFromName(existing)),
        InstanceEvent.WORKFLOW_SUCCESS,
      );

      const result = await binding.createBatch({
        instances: [{ id: fresh }, { id: existing }, { id: fresh }],
      });

      expect(result.created).toEqual([{ id: fresh }]);
      expect(result.errors).toEqual([
        {
          index: 1,
          id: existing,
          code: 10405,
          message: "workflows.api.error.instance.already_exists",
        },
        {
          index: 2,
          id: fresh,
          code: 10415,
          message: "workflows.api.error.instance.duplicate_in_batch",
        },
      ]);

      await waitUntilLogEvent(
        env.ENGINE.get(env.ENGINE.idFromName(fresh)),
        InstanceEvent.WORKFLOW_SUCCESS,
      );
    });

    it("should throw error for empty batch", async ({ expect }) => {
      const binding = createBinding();

      await expect(binding.createBatch([])).rejects.toThrow(
        "WorkflowError: batchCreate should have at least 1 instance",
      );
      await expect(binding.createBatch({ instances: [] })).rejects.toThrow(
        "(body) Batch size exceeds maximum allowed",
      );
      await expect(binding.createBatch({ count: 0 })).rejects.toThrow(
        "(body) count must be a positive integer",
      );
    });

    it("should reject invalid batch options", async ({ expect }) => {
      const binding = createBinding();
      const tooMany = Array.from({ length: 101 }, (_, i) => ({
        id: `too-many-${i}`,
      }));

      await expect(binding.createBatch(tooMany)).rejects.toThrow(
        "WorkflowError: batchCreate only supports 100 instances at a time",
      );
      await expect(binding.createBatch({ instances: tooMany })).rejects.toThrow(
        "(body) Batch size exceeds maximum allowed",
      );
      await expect(binding.createBatch({ count: 101 })).rejects.toThrow(
        "(body) batchCreate only supports 100 instances at a time",
      );
      await expect(binding.createBatch({ count: Number.MAX_SAFE_INTEGER })).rejects.toThrow(
        "(body) batchCreate only supports 100 instances at a time",
      );
      await expect(binding.createBatch({ count: -1 })).rejects.toThrow(
        "(body) count must be a positive integer",
      );
      await expect(binding.createBatch({ count: 1.5 })).rejects.toThrow(
        "(body) count must be a positive integer",
      );
      await expect(binding.createBatch({} as WorkflowBatchCreateOptions)).rejects.toThrow(
        "(body) Provided argument is invalid",
      );
      await expect(
        binding.createBatch({
          instances: [[]],
        } as unknown as WorkflowBatchCreateOptions),
      ).rejects.toThrow("(body) Expected object");
      await expect(
        binding.createBatch({
          count: 1,
          retention: { successRetention: "invalid" },
        } as unknown as WorkflowBatchCreateOptions),
      ).rejects.toThrow(
        "(body) Duration must be a number or a string in format '{{number}} {{unit}}' where unit is second(s), minute(s), etc.",
      );
      await expect(
        binding.createBatch({
          instances: [{ locationHint: "invalid" }],
        } as unknown as WorkflowBatchCreateOptions),
      ).rejects.toThrow('at ["locationHint"]');
    });

    it("should only accept positive retention durations", async ({ expect }) => {
      const binding = createBinding();
      setTestWorkflowCallback(async () => "done");

      for (const successRetention of [-1, 0, 0.5, "0 days", "-1 day"]) {
        await expect(
          binding.createBatch({
            count: 1,
            retention: { successRetention },
          } as unknown as WorkflowBatchCreateOptions),
        ).rejects.toThrow(
          "(body) Duration must be a number or a string in format '{{number}} {{unit}}' where unit is second(s), minute(s), etc.",
        );
      }

      const result = await binding.createBatch({
        count: 1,
        retention: { successRetention: 1000, errorRetention: "1 day" },
      });
      expect(result.created).toHaveLength(1);
      await waitUntilLogEvent(
        env.ENGINE.get(env.ENGINE.idFromName(result.created[0].id)),
        InstanceEvent.WORKFLOW_SUCCESS,
      );
    });

    it("should prefer count when instances are also provided", async ({ expect }) => {
      const binding = createBinding();
      setTestWorkflowCallback(async () => "done");

      const result = await binding.createBatch({
        count: 1,
        instances: [],
      } as unknown as WorkflowBatchCreateOptions);

      expect(result.created).toHaveLength(1);
      await waitUntilLogEvent(
        env.ENGINE.get(env.ENGINE.idFromName(result.created[0].id)),
        InstanceEvent.WORKFLOW_SUCCESS,
      );
    });

    it("should skip and exclude ids that already exist", async ({ expect }) => {
      const existing = uniqueId("dedup-existing");
      const fresh = uniqueId("dedup-fresh");
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(existing));
      setTestWorkflowCallback(async () => "done");

      const first = await binding.createBatch([{ id: existing }]);
      expect(first.map((r) => r.id)).toEqual([existing]);
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      const second = await binding.createBatch([{ id: existing }]);
      expect(second).toEqual([]);

      const mixed = await binding.createBatch([{ id: existing }, { id: fresh }]);
      expect(mixed.map((r) => r.id)).toEqual([fresh]);

      const freshStub = env.ENGINE.get(env.ENGINE.idFromName(fresh));
      await waitUntilLogEvent(freshStub, InstanceEvent.WORKFLOW_SUCCESS);
    });

    it("should collapse duplicate ids within a single batch", async ({ expect }) => {
      const id = uniqueId("dedup-in-batch");
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));
      setTestWorkflowCallback(async () => "done");

      const results = await binding.createBatch([{ id }, { id }, { id }]);
      expect(results.map((r) => r.id)).toEqual([id]);

      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);
    });

    it("should reject the whole batch before creating anything when an id is invalid", async ({
      expect,
    }) => {
      const good = uniqueId("batch-invalid-good");
      const binding = createBinding();
      setTestWorkflowCallback(async () => "done");

      await expect(binding.createBatch([{ id: good }, { id: "#invalid!" }])).rejects.toThrow(
        "Workflow instance has invalid id",
      );

      // The valid entry listed before the invalid one must not have been
      // created.
      await expect(binding.get(good)).rejects.toThrow("instance.not_found");
    });

    it("should reject reserved instance ids", async ({ expect }) => {
      const binding = createBinding();
      const reservedIds = ["batch", "terminate", "terminateAll", `cf_${"0".repeat(64)}`];

      for (const id of reservedIds) {
        await expect(binding.createBatch({ instances: [{ id }] })).rejects.toThrow(
          "(instance.invalid_id) Instance ID is invalid",
        );
      }
    });

    it("should keep accepting reserved ids in the array form", async ({ expect }) => {
      const binding = createBinding();
      const ids = ["batch", "terminate", "terminateAll", `cf_${"1".repeat(64)}`];
      setTestWorkflowCallback(async () => "done");

      const results = await binding.createBatch(ids.map((id) => ({ id })));

      expect(results.map((r) => r.id)).toEqual(ids);
      for (const id of ids) {
        await waitUntilLogEvent(
          env.ENGINE.get(env.ENGINE.idFromName(id)),
          InstanceEvent.WORKFLOW_SUCCESS,
        );
      }
    });

    it("should keep accepting unvalidated options in the array form", async ({ expect }) => {
      const binding = createBinding();
      const id = uniqueId("legacy-batch-options");
      setTestWorkflowCallback(async () => "done");

      const results = await binding.createBatch([
        {
          id,
          retention: { successRetention: "invalid" },
          locationHint: "invalid",
        },
      ] as unknown as WorkflowInstanceCreateOptions<unknown>[]);

      expect(results).toEqual([{ id }]);
      await waitUntilLogEvent(
        env.ENGINE.get(env.ENGINE.idFromName(id)),
        InstanceEvent.WORKFLOW_SUCCESS,
      );
    });

    it("should not create anything when a pending deletion cannot complete", async ({ expect }) => {
      const id = uniqueId("batch-cleanup-failed");
      const ctx = createExecutionContext();
      const diskFetch = vi.fn(() =>
        Promise.resolve(
          new Response(null, {
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      const storageEnv = {
        ENGINE: env.ENGINE,
        BINDING_NAME: "TEST_WORKFLOW",
        WORKFLOW_NAME: "test-workflow",
        WORKFLOW_STORAGE: { fetch: diskFetch } as unknown as Fetcher,
      };
      const binding = new WorkflowBinding(ctx, storageEnv);
      const hexId = env.ENGINE.idFromName(id).toString();
      const deletionError = "Refusing to delete a Workflow storage directory";
      await expect(
        deleteWorkflowStorage({
          disk: storageEnv.WORKFLOW_STORAGE,
          workflowName: storageEnv.WORKFLOW_NAME,
          ctx,
          hexId,
          abort: async () => {},
        }),
      ).rejects.toThrow(deletionError);

      await expect(binding.createBatch([{ id }])).rejects.toThrow(deletionError);
      await expect(binding.createBatch({ instances: [{ id }] })).rejects.toThrow(deletionError);
      await expect(createBinding().get(id)).rejects.toThrow("instance.not_found");

      diskFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 404 })));
      setTestWorkflowCallback(async () => "done");
      await expect(binding.createBatch({ instances: [{ id }] })).resolves.toEqual({
        created: [{ id }],
        errors: [],
      });
      await waitUntilLogEvent(
        env.ENGINE.get(env.ENGINE.idFromName(id)),
        InstanceEvent.WORKFLOW_SUCCESS,
      );
      await expect(waitOnExecutionContext(ctx)).resolves.toBeUndefined();
    });

    for (const kind of ["explicit", "generated"] as const) {
      it(`should wait for each ${kind} batch id's pending deletion`, async ({ expect }) => {
        const first = crypto.randomUUID();
        const second = crypto.randomUUID();
        if (kind === "generated") {
          vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(first).mockReturnValueOnce(second);
        }
        const ctx = createExecutionContext();
        const firstCleanup = Promise.withResolvers<void>();
        const secondCleanup = Promise.withResolvers<void>();
        const firstHexId = env.ENGINE.idFromName(first).toString();
        const secondHexId = env.ENGINE.idFromName(second).toString();
        const firstUrl = `http://disk/test-workflow/${firstHexId}.sqlite`;
        const secondUrl = `http://disk/test-workflow/${secondHexId}.sqlite`;
        const cleanupGates = new Map([
          [firstUrl, firstCleanup.promise],
          [secondUrl, secondCleanup.promise],
        ]);
        const engineGet = vi.fn((id: DurableObjectId) => env.ENGINE.get(id));
        const diskFetch = vi.fn(async (url: string) => {
          await cleanupGates.get(url);
          return new Response(null, { status: 404 });
        });
        const storageEnv = {
          ENGINE: {
            idFromName: (id: string) => env.ENGINE.idFromName(id),
            get: engineGet,
          } as unknown as DurableObjectNamespace<Engine>,
          BINDING_NAME: "TEST_WORKFLOW",
          WORKFLOW_NAME: "test-workflow",
          WORKFLOW_STORAGE: {
            fetch: diskFetch,
          } as unknown as Fetcher,
        };
        const binding = new WorkflowBinding(ctx, storageEnv);
        setTestWorkflowCallback(async () => "done");

        const deletions = [first, second].map((id) =>
          deleteWorkflowStorage({
            disk: storageEnv.WORKFLOW_STORAGE,
            workflowName: storageEnv.WORKFLOW_NAME,
            ctx,
            hexId: env.ENGINE.idFromName(id).toString(),
            abort: async () => {},
          }),
        );
        const creation = binding.createBatch(
          kind === "explicit"
            ? { instances: [{ id: first }, { id: second }, { id: first }] }
            : { count: 2 },
        );
        await vi.waitFor(() => {
          for (const url of [firstUrl, secondUrl]) {
            expect(diskFetch).toHaveBeenCalledWith(url, { method: "HEAD" });
          }
        });
        expect(engineGet).not.toHaveBeenCalled();
        firstCleanup.resolve();
        await deletions[0];
        await vi.waitFor(() => {
          expect(engineGet.mock.calls.map(([id]) => id.toString())).toContain(firstHexId);
        });
        expect(engineGet.mock.calls.map(([id]) => id.toString())).not.toContain(secondHexId);
        secondCleanup.resolve();
        await Promise.all(deletions);
        const result = await creation;
        expect(result.created).toEqual([{ id: first }, { id: second }]);
        for (const { id } of result.created) {
          await waitUntilLogEvent(
            env.ENGINE.get(env.ENGINE.idFromName(id)),
            InstanceEvent.WORKFLOW_SUCCESS,
          );
        }
      });
    }

    it("should create batch entries without ids under generated ids", async ({ expect }) => {
      const binding = createBinding();
      setTestWorkflowCallback(async () => "done");

      const results = await binding.createBatch([{}, {}]);
      expect(results).toHaveLength(2);
      expect(results[0].id).not.toBe(results[1].id);

      // Wait for both workflows to complete so the fire-and-forget
      // init() RPCs settle before teardown.
      for (const { id } of results) {
        const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));
        await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);
      }
    });
  });

  describe("deterministic id uniqueness", () => {
    it("should throw when creating an instance with an existing id", async ({ expect }) => {
      const id = uniqueId("dup-create");
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));
      setTestWorkflowCallback(async () => "done");

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      await expect(binding.create({ id })).rejects.toThrow(
        `(instance.already_exists) Workflow instance with id "${id}" already exists`,
      );
    });

    it("should not throw for auto-generated ids", async ({ expect }) => {
      const binding = createBinding();
      setTestWorkflowCallback(async () => "done");

      const first = await binding.create();
      const second = await binding.create();
      expect(first.id).not.toBe(second.id);

      // Wait for both workflows to complete so the fire-and-forget
      // init() RPCs settle before teardown.
      for (const { id } of [first, second]) {
        const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));
        await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);
      }
    });
  });
});

describe("WorkflowBinding", () => {
  it("should not call dispose when sending an event to an instance", async ({
    expect,
    onTestFinished,
  }) => {
    const id = uniqueId();
    const binding = createBinding();
    const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

    setTestWorkflowCallback(async (_event, step) => {
      const receivedEvent = await step.waitForEvent("wait-for-test-event", {
        type: "test-event",
        timeout: "10 seconds",
      });
      return receivedEvent;
    });

    const createdInstance = await binding.create({ id });
    expect(createdInstance.id).toBe(id);

    const instance = await binding.get(id);
    expect(instance.id).toBe(id);

    const disposeSpy = vi.fn();

    await runInDurableObject<Engine, void>(engineStub, (engine) => {
      // RPC methods must remain on the prototype to be callable by workerd.
      const enginePrototype = Object.getPrototypeOf(engine) as Engine;
      const originalReceiveEvent = enginePrototype.receiveEvent;
      const receiveEventSpy = vi.spyOn(enginePrototype, "receiveEvent");
      onTestFinished(() => receiveEventSpy.mockRestore());
      receiveEventSpy.mockImplementation(function (this: Engine, event) {
        const result = originalReceiveEvent.call(this, event);
        return Object.assign(result, {
          [Symbol.dispose]: disposeSpy,
        });
      });
    });

    using _ = (await instance.sendEvent({
      type: "test-event",
      payload: { test: "data" },
    })) as unknown as Disposable;

    await vi.waitUntil(
      async () => {
        const status = await instance.status();
        return status.status === "complete";
      },
      { timeout: 5000 },
    );

    expect(disposeSpy).not.toHaveBeenCalled();
  });
});

describe("WorkflowHandle", () => {
  describe("status()", () => {
    it("should return running status for a workflow waiting for an event", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.waitForEvent("wait-for-event", {
          type: "some-event",
          timeout: "2 seconds",
        });
        return "completed";
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WAIT_START);

      const instance = await binding.get(id);
      const status = await instance.status();

      expect(status.status).toBe("running");
      expect(status.output).toBeNull();
      expect(status.error).toBeUndefined();

      // Terminate the waiting workflow so the init() RPC settles
      // before teardown (the 2-second waitForEvent timeout would
      // otherwise leave the workflow running past test end).
      await instance.terminate();
    });

    it("should return complete status and output for a successful workflow", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));
      const expectedOutput = { result: "success", value: 42 };

      setTestWorkflowCallback(async () => expectedOutput);
      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      const instance = await binding.get(id);
      const status = await instance.status();

      expect(status.status).toBe("complete");
      expect(status.output).toEqual(expectedOutput);
      expect(status.error).toBeUndefined();
    });

    it("should return errored status and error for a failed workflow", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async () => {
        throw new Error("Workflow failed intentionally");
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_FAILURE);

      const instance = await binding.get(id);
      const status = await instance.status();

      expect(status.status).toBe("errored");
      expect(status.error).toBeDefined();
      expect(status.error?.message).toBe("Workflow failed intentionally");
      expect(status.output).toBeNull();
    });

    it("should return step outputs in __LOCAL_DEV_STEP_OUTPUTS", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        const step1Result = await step.do("step-1", async () => "result-from-step-1");
        const step2Result = await step.do("step-2", async () => ({
          data: "result-from-step-2",
        }));
        const step3Result = await step.do("step-3", async () => 123);
        return { step1Result, step2Result, step3Result };
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      const instance = (await binding.get(id)) as WorkflowHandle;
      const status = await instance.status();

      expect(status.status).toBe("complete");
      expect(status.__LOCAL_DEV_STEP_OUTPUTS).toHaveLength(3);
      expect(status.__LOCAL_DEV_STEP_OUTPUTS[0]).toBe("result-from-step-1");
      expect(status.__LOCAL_DEV_STEP_OUTPUTS[1]).toEqual({
        data: "result-from-step-2",
      });
      expect(status.__LOCAL_DEV_STEP_OUTPUTS[2]).toBe(123);
    });

    it("should return terminated status for a terminated instance", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.waitForEvent("wait-for-event", {
          type: "some-event",
          timeout: "1 second",
        });
        return "completed";
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WAIT_START);

      const instance = await binding.get(id);
      await instance.terminate();

      const newInstance = await binding.get(id);
      const status = await newInstance.status();

      expect(status.status).toBe("terminated");
    });
  });

  describe("subscribe()", () => {
    it("finishes a pending next request when disposed", async ({ expect }) => {
      const started = Promise.withResolvers<void>();
      const pendingEvent =
        Promise.withResolvers<IteratorResult<WorkflowSubscriptionEvent, undefined>>();
      const onClose = vi.fn();
      const subscription = new WorkflowSubscriptionTarget(async () => {
        started.resolve();
        return pendingEvent.promise;
      }, onClose);

      const result = subscription.next();
      await started.promise;
      subscription[Symbol.dispose]();
      pendingEvent.resolve({
        done: false,
        value: {
          type: "workflow_queued",
          instanceId: "disposed-subscription",
          eventId: 0,
          timestamp: Date.now(),
        },
      });

      expect(await result).toEqual({ done: true, value: undefined });
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("closes after returning a terminal event", async ({ expect }) => {
      const onClose = vi.fn();
      const terminalEvent = {
        type: "workflow_completed",
        instanceId: "completed-subscription",
        eventId: 1,
        timestamp: Date.now(),
        output: "done",
      } as const satisfies WorkflowSubscriptionEvent;
      const subscription = new WorkflowSubscriptionTarget(
        () =>
          Promise.resolve({
            done: false as const,
            value: terminalEvent,
          }),
        onClose,
      );

      expect(await subscription.next()).toEqual({
        done: false,
        value: terminalEvent,
      });
      expect(onClose).toHaveBeenCalledOnce();
      expect(await subscription.next()).toEqual({
        done: true,
        value: undefined,
      });
    });

    it("streams historical events in log order through a disposable RPC target", async ({
      expect,
    }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.do(
          "subscription step",
          {
            retries: {
              limit: 3,
              delay: () => "2 seconds" as const,
              backoff: "linear",
            },
            timeout: "30 seconds",
          },
          async () => "step output",
        );
        return "workflow output";
      });

      await binding.create({ id, params: { input: true } });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      const instance = (await binding.get(id)) as WorkflowHandle;
      using subscription = await instance.subscribe();
      const events: Array<{
        eventId: number;
        type: string;
        [key: string]: unknown;
      }> = [];
      while (true) {
        const result = await subscription.next();
        if (result.done) {
          break;
        }
        events.push(result.value);
      }

      expect(events.map(({ type }) => type)).toEqual([
        "workflow_queued",
        "workflow_started",
        "workflow_running",
        "step_started",
        "attempt_started",
        "attempt_completed",
        "step_completed",
        "workflow_completed",
      ]);
      expect(events[2]).toMatchObject({
        type: "workflow_running",
      });
      const firstEvent = events[0];
      if (firstEvent === undefined) {
        throw new Error("Expected subscription events");
      }
      expect(events.map(({ eventId }) => eventId)).toEqual(
        Array.from({ length: events.length }, (_, index) => firstEvent.eventId + index),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "workflow_started",
          params: { input: true },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "step_started",
          stepName: "subscription step-1",
          config: {
            retries: {
              limit: 3,
              delay: "[dynamic]",
              backoff: "linear",
            },
            timeout: "30 seconds",
          },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "step_completed",
          stepName: "subscription step-1",
          output: "step output",
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: "workflow_completed",
        output: "workflow output",
      });
      expect(await subscription.next()).toEqual({
        done: true,
        value: undefined,
      });
    });

    it("uses errored event names for Workflow and step failures", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.do(
          "failing subscription step",
          { retries: { limit: 0, delay: 0 } },
          async () => {
            throw new Error("subscription failure");
          },
        );
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_FAILURE);

      const instance = (await binding.get(id)) as WorkflowHandle;
      using subscription = await instance.subscribe();
      const eventTypes: Array<string> = [];
      while (true) {
        const result = await subscription.next();
        if (result.done) {
          break;
        }
        eventTypes.push(result.value.type);
      }

      expect(eventTypes).toContain("attempt_errored");
      expect(eventTypes).toContain("step_errored");
      expect(eventTypes.at(-1)).toBe("workflow_errored");
    });

    it("includes the resolved rollback config in rollback step events", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.do("rollback subscription step", async () => "step output", {
          rollback: async () => {},
          rollbackConfig: {
            retries: {
              limit: 0,
              delay: "1 second",
              backoff: "constant",
            },
            timeout: "30 seconds",
          },
        });
        throw new Error("trigger rollback");
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.ROLLBACK_COMPLETE);

      const instance = (await binding.get(id)) as WorkflowHandle;
      using subscription = await instance.subscribe({
        filter: ["rollback_step_started", "workflow_errored"],
      });
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: {
          type: "rollback_step_started",
          stepName: "rollback subscription step-1",
          config: {
            retries: {
              limit: 0,
              delay: "1 second",
              backoff: "constant",
            },
            timeout: "30 seconds",
          },
        },
      });
    });

    it("returns stored structured and streamed step outputs", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.do("structured output", async () => ({ total: 1n }));
        const stream = await step.do("stream output", async () => {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("streamed step output"));
              controller.close();
            },
          });
        });
        await new Response(stream as ReadableStream<Uint8Array>).arrayBuffer();
        await step.do("sensitive output", { sensitive: "output" }, async () => "secret");
        await step.do("undefined output", async () => undefined);
        await step.do("null output", async () => null);
        return "done";
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      const instance = (await binding.get(id)) as WorkflowHandle;
      using subscription = await instance.subscribe({
        filter: ["step_completed", "workflow_completed"],
      });

      const structuredResult = await subscription.next();
      if (structuredResult.done || structuredResult.value.type !== "step_completed") {
        throw new Error("Expected a structured step output event");
      }
      const structuredEvent = structuredResult.value;
      expect(structuredEvent).toMatchObject({
        type: "step_completed",
        stepName: "structured output-1",
        output: { total: 1n },
      });

      const streamResult = await subscription.next();
      if (streamResult.done || streamResult.value.type !== "step_completed") {
        throw new Error("Expected a streamed step output event");
      }
      const streamEvent = streamResult.value;
      expect(streamEvent).toMatchObject({
        type: "step_completed",
        stepName: "stream output-1",
      });
      expect(streamEvent.output).toBeInstanceOf(ReadableStream);
      expect(await new Response(streamEvent.output as ReadableStream<Uint8Array>).text()).toBe(
        "streamed step output",
      );

      expect(await subscription.next()).toMatchObject({
        done: false,
        value: {
          type: "step_completed",
          stepName: "sensitive output-1",
          output: "[REDACTED]",
        },
      });
      const undefinedResult = await subscription.next();
      expect(undefinedResult).toMatchObject({
        done: false,
        value: {
          type: "step_completed",
          stepName: "undefined output-1",
        },
      });
      if (!undefinedResult.done) {
        expect("output" in undefinedResult.value).toBe(false);
      }
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: {
          type: "step_completed",
          stepName: "null output-1",
          output: null,
        },
      });
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: { type: "workflow_completed", output: "done" },
      });
    });

    it("returns full structured workflow outputs while keeping logs JSON-safe", async ({
      expect,
    }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));
      const createWorkflowOutput = () => ({
        count: 42n,
        typedArray: new Uint16Array([1, 2]),
        arrayBuffer: new Uint8Array([3, 4, 5]).buffer,
        completedAt: new Date("2026-09-09T12:00:00.000Z"),
        values: new Map([["nested", new Set([6n, 7n])]]),
      });

      setTestWorkflowCallback(async () => createWorkflowOutput());
      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      const instance = (await binding.get(id)) as WorkflowHandle;
      using subscription = await instance.subscribe({
        filter: ["workflow_completed"],
      });
      const result = await subscription.next();
      if (result.done || result.value.type !== "workflow_completed") {
        throw new Error("Expected a completed Workflow event");
      }
      expect(result.value.output).toEqual(createWorkflowOutput());

      const logs = (await engineStub.readLogs()) as EngineLogs;
      const completedLog = logs.logs.find((log) => log.event === InstanceEvent.WORKFLOW_SUCCESS);
      expect(completedLog?.metadata.result).toEqual({
        count: "[BigInt(42)]",
        typedArray: "[Uint16Array(4 bytes)]",
        arrayBuffer: "[ArrayBuffer(3 bytes)]",
        completedAt: "2026-09-09T12:00:00.000Z",
        values: {},
      });
    });

    it("rejects when a stored streamed step output is corrupt", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        const stream = await step.do("stream output", async () => {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("streamed output"));
              controller.close();
            },
          });
        });
        await new Response(stream as ReadableStream<Uint8Array>).arrayBuffer();
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);
      await runInDurableObject(engineStub, (_engine, state) => {
        const step = state.storage.sql
          .exec<{ groupKey: string }>(
            "SELECT groupKey FROM states WHERE event = ? LIMIT 1",
            InstanceEvent.STEP_SUCCESS,
          )
          .one();
        if (step === null) {
          throw new Error("Expected a completed step");
        }
        state.storage.sql.exec(
          "DELETE FROM streaming_step_chunks WHERE cache_key = ?",
          step.groupKey,
        );
      });

      await runInDurableObject(engineStub, async (engine) => {
        const subscription = await engine.subscribe({
          filter: ["step_completed"],
        });
        await expect(subscription.next()).rejects.toThrow(
          "Step has completed but its stored stream output is corrupt or incomplete",
        );
        expect(await subscription.next()).toEqual({
          done: true,
          value: undefined,
        });
      });
    });

    it("returns done when the cursor is at or after a terminal event", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async () => "done");
      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      const getEventId = async (event: InstanceEvent) => {
        const logs = (await engineStub.readDetailedLogs()) as Array<{
          id: number;
          event: InstanceEvent;
        }>;
        const eventId = logs.find((log) => log.event === event)?.id;
        if (eventId === undefined) {
          throw new Error(`Expected Workflow event ${event}`);
        }
        return eventId;
      };
      const expectDoneAtCursor = async (cursor: number) => {
        const instance = (await binding.get(id)) as WorkflowHandle;
        using subscription = await instance.subscribe({ cursor });
        const result = Promise.resolve(subscription.next());
        await expect(
          Promise.race([result, scheduler.wait(1000).then(() => "timed out" as const)]),
        ).resolves.toEqual({ done: true, value: undefined });
      };

      const terminalEventId = await getEventId(InstanceEvent.WORKFLOW_SUCCESS);
      await expectDoneAtCursor(terminalEventId);

      await runInDurableObject(engineStub, (engine) => {
        engine.writeLog(InstanceEvent.__INTERNAL_PROD, null, null, {});
      });
      const laterInternalEventId = await getEventId(InstanceEvent.__INTERNAL_PROD);
      await expectDoneAtCursor(laterInternalEventId);
    });

    it("waits for live events and applies cursor and filter options", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.waitForEvent("subscription wait", {
          type: "continue",
          timeout: "10 seconds",
        });
        return "done";
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WAIT_START);

      const logs = (await engineStub.readDetailedLogs()) as Array<{
        id: number;
        event: InstanceEvent;
      }>;
      const startEventId = logs.find(({ event }) => event === InstanceEvent.WORKFLOW_START)?.id;
      if (startEventId === undefined) {
        throw new Error("Expected a workflow start event");
      }

      const instance = (await binding.get(id)) as WorkflowHandle;
      using subscription = await instance.subscribe({
        cursor: startEventId,
        filter: ["workflow_queued", "wait_started", "workflow_completed"],
      });
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: {
          type: "wait_started",
          stepName: "subscription wait-1",
          eventType: "continue",
        },
      });

      const terminalEvent = subscription.next();
      await instance.sendEvent({ type: "continue", payload: null });
      expect(await terminalEvent).toMatchObject({
        done: false,
        value: { type: "workflow_completed", output: "done" },
      });
      expect(await subscription.next()).toEqual({
        done: true,
        value: undefined,
      });
    });

    it("streams explicit Workflow status events", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.waitForEvent("status subscription wait", {
          type: "continue",
          timeout: "10 seconds",
        });
        return "done";
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WAIT_START);

      const instance = (await binding.get(id)) as WorkflowHandle;
      using subscription = await instance.subscribe({
        filter: [
          "workflow_queued",
          "workflow_running",
          "workflow_waiting",
          "workflow_waiting_for_pause",
          "workflow_paused",
          "workflow_completed",
        ],
      });

      expect(await subscription.next()).toMatchObject({
        done: false,
        value: { type: "workflow_queued" },
      });
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: { type: "workflow_running" },
      });

      await engineStub.setStatus(0, id, InstanceStatus.Waiting);
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: { type: "workflow_waiting" },
      });

      await engineStub.setStatus(0, id, InstanceStatus.Queued);
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: { type: "workflow_queued" },
      });
      await engineStub.setStatus(0, id, InstanceStatus.Running);
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: { type: "workflow_running" },
      });

      await engineStub.setStatus(0, id, InstanceStatus.WaitingForPause);
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: { type: "workflow_waiting_for_pause" },
      });
      await engineStub.setStatus(0, id, InstanceStatus.Paused);
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: { type: "workflow_paused" },
      });

      await engineStub.setStatus(0, id, InstanceStatus.Running);
      expect(await subscription.next()).toMatchObject({
        done: false,
        value: { type: "workflow_running" },
      });
      const terminalEvent = subscription.next();
      await instance.sendEvent({ type: "continue", payload: null });
      expect(await terminalEvent).toMatchObject({
        done: false,
        value: { type: "workflow_completed", output: "done" },
      });
      expect(await subscription.next()).toEqual({
        done: true,
        value: undefined,
      });

      const explicitStatusEventTypes = new Set<InstanceEvent>([
        InstanceEvent.WORKFLOW_QUEUED,
        InstanceEvent.WORKFLOW_RUNNING,
        InstanceEvent.WORKFLOW_PAUSED,
        InstanceEvent.WORKFLOW_WAITING_FOR_PAUSE,
        InstanceEvent.WORKFLOW_WAITING,
      ]);
      const statusEvents = (
        (await engineStub.readDetailedLogs()) as Array<{
          event: InstanceEvent;
        }>
      )
        .filter(({ event }) => explicitStatusEventTypes.has(event))
        .map(({ event }) => event);
      expect(statusEvents).toEqual([
        InstanceEvent.WORKFLOW_QUEUED,
        InstanceEvent.WORKFLOW_RUNNING,
        InstanceEvent.WORKFLOW_WAITING,
        InstanceEvent.WORKFLOW_QUEUED,
        InstanceEvent.WORKFLOW_RUNNING,
        InstanceEvent.WORKFLOW_WAITING_FOR_PAUSE,
        InstanceEvent.WORKFLOW_PAUSED,
        InstanceEvent.WORKFLOW_RUNNING,
      ]);
    });

    it("rejects invalid subscription options", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async () => undefined);
      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      const instance = await binding.get(id);
      const unsafeInstance = instance as unknown as {
        subscribe(options: unknown): Promise<WorkflowSubscription>;
      };
      const invalidOptions: Array<[description: string, options: unknown]> = [
        ["null", null],
        ["an array", []],
        ["a negative cursor", { cursor: -1 }],
        ["a fractional cursor", { cursor: 1.5 }],
        ["an unsafe cursor", { cursor: Number.MAX_SAFE_INTEGER + 1 }],
        ["a non-array filter", { filter: "workflow_started" }],
        ["a non-string event filter", { filter: [42] }],
        ["an unknown event filter", { filter: ["does_not_exist"] }],
        ["the internal event filter", { filter: ["internal"] }],
        ["an unknown option", { unexpected: true }],
      ];

      for (const [description, options] of invalidOptions) {
        await expect(unsafeInstance.subscribe(options), description).rejects.toThrow(
          "Invalid Workflow subscription options",
        );
      }
    });

    it("streams a persisted termination event after the Engine aborts", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.waitForEvent("termination wait", {
          type: "never",
          timeout: "10 seconds",
        });
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WAIT_START);
      const instance = await binding.get(id);
      await instance.terminate();

      const terminatedInstance = (await binding.get(id)) as WorkflowHandle;
      using subscription = await terminatedInstance.subscribe({
        filter: ["workflow_terminated"],
      });

      expect(await subscription.next()).toMatchObject({
        done: false,
        value: { type: "workflow_terminated" },
      });
    });
  });

  describe("sendEvent()", () => {
    it("should deliver event payload to a waiting workflow", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        const receivedEvent = await step.waitForEvent("wait-for-event", {
          type: "my-event-type",
          timeout: "2 seconds",
        });
        return receivedEvent;
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WAIT_START);

      const instance = await binding.get(id);
      const eventPayload = { message: "hello", count: 42 };

      await instance.sendEvent({
        type: "my-event-type",
        payload: eventPayload,
      });

      await vi.waitUntil(
        async () => {
          const status = await instance.status();
          return status.status === "complete";
        },
        { timeout: 5000 },
      );

      const status = await instance.status();
      expect(status.output).toMatchObject({
        payload: eventPayload,
        type: "my-event-type",
      });
    });

    it("should handle multiple sequential events", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        const event1 = await step.waitForEvent("wait-1", {
          type: "event-type-1",
          timeout: "10 seconds",
        });
        const event2 = await step.waitForEvent("wait-2", {
          type: "event-type-2",
          timeout: "10 seconds",
        });
        return { first: event1.payload, second: event2.payload };
      });

      await binding.create({ id });
      const instance = await binding.get(id);

      await waitUntilLogEvent(engineStub, InstanceEvent.WAIT_START);
      await instance.sendEvent({
        type: "event-type-1",
        payload: { value: "first" },
      });

      // Wait for the second waitForEvent
      await vi.waitUntil(
        async () => {
          const logs = (await engineStub.readLogs()) as EngineLogs;
          const waitStarts = logs.logs.filter((log) => log.event === InstanceEvent.WAIT_START);
          return waitStarts.length === 2;
        },
        { timeout: 5000 },
      );

      await instance.sendEvent({
        type: "event-type-2",
        payload: { value: "second" },
      });

      await vi.waitUntil(
        async () => {
          const status = await instance.status();
          return status.status === "complete";
        },
        { timeout: 5000 },
      );

      const status = await instance.status();
      expect(status.output).toEqual({
        first: { value: "first" },
        second: { value: "second" },
      });
    });
  });

  describe("terminate()", () => {
    it("should terminate a running workflow instance", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.waitForEvent("wait-for-event", {
          type: "some-event",
          timeout: "1 second",
        });
        await step.do("should not be called", async () => {
          return "should not be called";
        });
        return "should never complete";
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WAIT_START);

      const instance = await binding.get(id);
      await instance.terminate();

      // Get a new stub since the engine was aborted
      const newEngineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      const status = await runInDurableObject(newEngineStub, (engine) => {
        return engine.getStatus();
      });
      expect(status).toBe(InstanceStatus.Terminated);

      const logs = (await newEngineStub.readLogs()) as EngineLogs;
      const hasTerminatedEvent = logs.logs.some(
        (log) => log.event === InstanceEvent.WORKFLOW_TERMINATED,
      );
      expect(hasTerminatedEvent).toBe(true);

      // assert that step.do never started
      const hasStepStart = logs.logs.some((log) => log.event === InstanceEvent.STEP_START);
      expect(hasStepStart).toBe(false);
    });
  });

  describe("restart()", () => {
    it("should restart a workflow instance", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.sleep("sleep", 250);
        return "complete";
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

      let instance = await binding.get(id);
      let status = await instance.status();
      expect(status.status).toBe("complete");

      // restart() aborts the old DO, gets a fresh stub, and calls attemptRestart()
      // The service binding (USER_WORKFLOW) survives the abort, so no re-setup needed
      await instance.restart();

      const statusAfterRestart = await instance.status();
      expect(statusAfterRestart.status).toBe("running");

      // Wait for the restarted workflow to complete via status polling
      await vi.waitUntil(
        async () => {
          const s = await instance.status();
          return s.status === "complete";
        },
        { timeout: 5000 },
      );

      // Verify second run completed
      instance = await binding.get(id);
      status = await instance.status();
      expect(status.status).toBe("complete");
    });
  });

  describe("pause()", () => {
    it("should pause a running workflow", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.do("long-step", async () => {
          await scheduler.wait(500);
          return "result-1";
        });
        // step-2 should never run because pause takes effect after long-step
        await step.do("step-2", async () => "result-2");
        return "done";
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.STEP_START);

      const instance = await binding.get(id);

      // Pause while long-step is in flight
      await instance.pause();

      await vi.waitUntil(
        async () => {
          const s = await instance.status();
          return s.status === "paused";
        },
        { timeout: 5000 },
      );

      const finalStatus = await instance.status();
      expect(finalStatus.status).toBe("paused");
    });
  });

  describe("resume()", () => {
    it("should resume a paused workflow and complete it", async ({ expect }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.do("long-step", async () => {
          await scheduler.wait(500);
          return "result-1";
        });
        await step.do("step-2", async () => "result-2");
        return "all-done";
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.STEP_START);

      const instance = await binding.get(id);

      // Pause while long-step is in flight
      await instance.pause();

      await vi.waitUntil(
        async () => {
          const s = await instance.status();
          return s.status === "paused";
        },
        { timeout: 5000 },
      );

      await instance.resume();

      await vi.waitUntil(
        async () => {
          const s = await instance.status();
          return s.status === "complete";
        },
        { timeout: 5000 },
      );

      const finalStatus = await instance.status();
      expect(finalStatus.status).toBe("complete");
      expect(finalStatus.output).toBe("all-done");
    });

    it("should cancel a pending pause when resume is called before step finishes", async ({
      expect,
    }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        await step.do("long-step", async () => {
          await scheduler.wait(1000);
          return "long-result";
        });
        await step.do("step-after", async () => "final-result");
        return "completed";
      });

      await binding.create({ id });
      await waitUntilLogEvent(engineStub, InstanceEvent.STEP_START);

      const instance = await binding.get(id);

      // Pause while long-step is in flight — sets WaitingForPause
      await instance.pause();

      const statusAfterPause = await instance.status();
      expect(statusAfterPause.status).toBe("waitingForPause");

      // resume before the step finishes — this should cancel the pending pause
      await instance.resume();

      // status should go back to Running
      const statusAfterResume = await instance.status();
      expect(statusAfterResume.status).toBe("running");

      await vi.waitUntil(
        async () => {
          const s = await instance.status();
          return s.status === "complete";
        },
        { timeout: 5000 },
      );

      const finalStatus = await instance.status();
      expect(finalStatus.status).toBe("complete");
      expect(finalStatus.output).toBe("completed");
    });
  });
});

describe("WorkflowBinding instance methods by id", () => {
  it("getInstance() returns the id of an existing instance", async ({ expect }) => {
    const id = uniqueId();
    const binding = createBinding();
    const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

    setTestWorkflowCallback(async () => "done");

    await binding.create({ id });
    await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

    expect(await binding.getInstance(id)).toEqual({ id });
  });

  it.for([
    ["getInstance"],
    ["pause"],
    ["resume"],
    ["terminate"],
    ["restart"],
    ["status"],
    ["sendEvent"],
    ["subscribe"],
  ] as const)(
    "%s() rejects with instance.not_found for an unknown id",
    async ([method], { expect }) => {
      const binding = createBinding();

      await expect(
        binding[method](uniqueId("missing"), {
          type: "event",
          payload: null,
        }),
      ).rejects.toThrow("instance.not_found");
    },
  );

  it("status() and sendEvent() address an instance by id", async ({ expect }) => {
    const id = uniqueId();
    const binding = createBinding();
    const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

    setTestWorkflowCallback(async (_event, step) => {
      const received = await step.waitForEvent("wait-for-event", {
        type: "some-event",
        timeout: "10 seconds",
      });
      return received.payload;
    });

    await binding.create({ id });
    await waitUntilLogEvent(engineStub, InstanceEvent.WAIT_START);
    expect((await binding.status(id)).status).toBe("running");

    await binding.sendEvent(id, { type: "some-event", payload: "hello" });

    await vi.waitUntil(async () => (await binding.status(id)).status === "complete", {
      timeout: 5000,
    });
    expect((await binding.status(id)).output).toBe("hello");
  });

  it("pause() and resume() address an instance by id", async ({ expect }) => {
    const id = uniqueId();
    const binding = createBinding();
    const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

    setTestWorkflowCallback(async (_event, step) => {
      await step.do("long-step", async () => {
        await scheduler.wait(500);
        return "result-1";
      });
      await step.do("step-2", async () => "result-2");
      return "all-done";
    });

    await binding.create({ id });
    await waitUntilLogEvent(engineStub, InstanceEvent.STEP_START);

    await binding.pause(id);
    await vi.waitUntil(async () => (await binding.status(id)).status === "paused", {
      timeout: 5000,
    });

    await binding.resume(id);
    await vi.waitUntil(async () => (await binding.status(id)).status === "complete", {
      timeout: 5000,
    });
    expect((await binding.status(id)).output).toBe("all-done");
  });

  it("terminate() addresses an instance by id", async ({ expect }) => {
    const id = uniqueId();
    const binding = createBinding();
    const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

    setTestWorkflowCallback(async (_event, step) => {
      await step.waitForEvent("wait-for-event", {
        type: "some-event",
        timeout: "10 seconds",
      });
      return "should never complete";
    });

    await binding.create({ id });
    await waitUntilLogEvent(engineStub, InstanceEvent.WAIT_START);

    await binding.terminate(id);

    expect((await binding.status(id)).status).toBe("terminated");
  });

  it("restart() addresses an instance by id", async ({ expect }) => {
    const id = uniqueId();
    const binding = createBinding();
    const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));
    let runs = 0;

    setTestWorkflowCallback(async () => {
      runs++;
      return "complete";
    });

    await binding.create({ id });
    await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

    await binding.restart(id);

    await vi.waitUntil(async () => runs === 2 && (await binding.status(id)).status === "complete", {
      timeout: 5000,
    });
    expect(runs).toBe(2);
  });

  it("subscribe() addresses an instance by id", async ({ expect }) => {
    const id = uniqueId();
    const binding = createBinding();
    const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

    setTestWorkflowCallback(async () => "done");

    await binding.create({ id });
    await waitUntilLogEvent(engineStub, InstanceEvent.WORKFLOW_SUCCESS);

    using subscription = (await binding.subscribe(id)) as unknown as WorkflowSubscription;
    const types: string[] = [];
    while (true) {
      const result = await subscription.next();
      if (result.done) {
        break;
      }
      types.push(result.value.type);
    }

    expect(types.at(-1)).toBe("workflow_completed");
  });
});
