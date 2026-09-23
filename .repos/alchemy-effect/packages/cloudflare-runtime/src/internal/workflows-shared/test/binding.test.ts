// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Alchemy modifications: tests RPC disposal with a typed stub because the current Vitest pool does not expose methods replaced on a live Durable Object.
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, it, vi } from "vitest";
import { InstanceEvent, InstanceStatus } from "../index.ts";
import { WorkflowBinding, WorkflowHandle } from "../binding.ts";
import { setTestWorkflowCallback } from "./test-entry.ts";
import type { Engine, EngineLogs } from "../engine.ts";
import type { WorkflowEvent } from "cloudflare:workers";

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
    it("should create an instance with provided id and params", async ({
      expect,
    }) => {
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

    it("should throw WorkflowError for invalid instance id", async ({
      expect,
    }) => {
      const binding = createBinding();
      await expect(binding.create({ id: "#invalid!" })).rejects.toThrow(
        "Workflow instance has invalid id",
      );
    });

    it("should block creation when pending persistence deletion fails", async ({
      expect,
    }) => {
      const binding = new WorkflowBinding(createExecutionContext(), {
        ENGINE: env.ENGINE,
        BINDING_NAME: "TEST_WORKFLOW",
        WORKFLOW_NAME: "test-workflow",
        MINIFLARE_LOOPBACK: {
          fetch: () => Promise.resolve(new Response(null, { status: 500 })),
        } as unknown as Fetcher,
      });

      await expect(binding.create({ id: "cleanup-failed" })).rejects.toThrow(
        "Failed to wait for persisted workflow instance 'cleanup-failed' deletion",
      );
    });
  });

  describe("get()", () => {
    it("should return a WorkflowHandle for an existing instance", async ({
      expect,
    }) => {
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
    it("deleteInstance should delete an instance and wipe its stored state", async ({
      expect,
    }) => {
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
      await expect(
        createBinding().deleteInstance("*/30 * * * *-1786001400000"),
      ).rejects.toThrow("instance.not_found");
    });

    it("should let a running instance delete itself and stop execution", async ({
      expect,
    }) => {
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
    it("should delete instances and wipe their stored state", async ({
      expect,
    }) => {
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

    it("should report each duplicate missing cron-generated ID", async ({
      expect,
    }) => {
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
      const deleteInstance = vi
        .fn()
        .mockRejectedValue(new Error("sensitive failure"));
      const binding = new WorkflowBinding(createExecutionContext(), {
        ENGINE: {
          idFromName: (id: string) => id,
          get: () => ({ deleteInstance }),
        } as unknown as DurableObjectNamespace<Engine>,
        BINDING_NAME: "TEST_WORKFLOW",
        WORKFLOW_NAME: "test-workflow",
      });

      await expect(
        binding.deleteBatch({ instances: ["broken-instance"] }),
      ).resolves.toEqual({
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

    it("should report persistence cleanup failures per instance", async ({
      expect,
    }) => {
      const abort = vi.fn(() =>
        Promise.reject(new Error("Durable Object aborted")),
      );
      const loopbackFetch = vi.fn((url: string) =>
        Promise.resolve(
          new Response(null, {
            status: url.includes("/cleanup-failed") ? 500 : 204,
          }),
        ),
      );
      const binding = new WorkflowBinding(createExecutionContext(), {
        ENGINE: {
          idFromName: (id: string) => ({ toString: () => id }),
          get: (id: { toString(): string }) => ({
            id,
            deleteInstance: () => {
              if (id.toString() === "missing") {
                return Promise.reject(
                  new Error("(instance.not_found) Instance does not exist"),
                );
              }
              return Promise.resolve();
            },
            unsafeAbort: abort,
          }),
        } as unknown as DurableObjectNamespace<Engine>,
        BINDING_NAME: "TEST_WORKFLOW",
        WORKFLOW_NAME: "test-workflow",
        MINIFLARE_LOOPBACK: { fetch: loopbackFetch } as unknown as Fetcher,
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
      expect(loopbackFetch.mock.calls.map(([url]) => url)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("/missing?defer=1"),
          expect.stringContaining("/missing?waitForPendingDelete=1"),
        ]),
      );
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
      ).rejects.toThrow(
        "(body) batchDeleteInstances only supports 100 instances at a time",
      );
      await expect(binding.deleteBatch({ instances: [""] })).rejects.toThrow(
        "(instance.invalid_id) Instance ID is invalid",
      );
    });
  });

  describe("createBatch()", () => {
    it("should create multiple instances in a batch", async ({ expect }) => {
      const binding = createBinding();
      const ids = ["batch-1", "batch-2", "batch-3"];
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

    it("should throw error for empty batch", async ({ expect }) => {
      const binding = createBinding();

      await expect(binding.createBatch([])).rejects.toThrow(
        "WorkflowError: batchCreate should have at least 1 instance",
      );
    });
  });
});

describe("WorkflowBinding", () => {
  it("should not call dispose when sending an event to an instance", async ({
    expect,
  }) => {
    const id = uniqueId();
    const disposeSpy = vi.fn();
    const receiveEvent = vi.fn(() =>
      Object.assign(Promise.resolve(), { [Symbol.dispose]: disposeSpy }),
    );
    const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));
    Object.defineProperty(engineStub, "receiveEvent", { value: receiveEvent });
    const instance = new WorkflowHandle(id, engineStub, () => engineStub);

    using _ = (await instance.sendEvent({
      type: "test-event",
      payload: { test: "data" },
    })) as unknown as Disposable;

    expect(receiveEvent).toHaveBeenCalledOnce();
    expect(disposeSpy).not.toHaveBeenCalled();
  });
});

describe("WorkflowHandle", () => {
  describe("status()", () => {
    it("should return running status for a workflow waiting for an event", async ({
      expect,
    }) => {
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

    it("should return complete status and output for a successful workflow", async ({
      expect,
    }) => {
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

    it("should return errored status and error for a failed workflow", async ({
      expect,
    }) => {
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

    it("should return step outputs in __LOCAL_DEV_STEP_OUTPUTS", async ({
      expect,
    }) => {
      const id = uniqueId();
      const binding = createBinding();
      const engineStub = env.ENGINE.get(env.ENGINE.idFromName(id));

      setTestWorkflowCallback(async (_event, step) => {
        const step1Result = await step.do(
          "step-1",
          async () => "result-from-step-1",
        );
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

    it("should return terminated status for a terminated instance", async ({
      expect,
    }) => {
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

  describe("sendEvent()", () => {
    it("should deliver event payload to a waiting workflow", async ({
      expect,
    }) => {
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
          const waitStarts = logs.logs.filter(
            (log) => log.event === InstanceEvent.WAIT_START,
          );
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
      const hasStepStart = logs.logs.some(
        (log) => log.event === InstanceEvent.STEP_START,
      );
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
    it("should resume a paused workflow and complete it", async ({
      expect,
    }) => {
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
