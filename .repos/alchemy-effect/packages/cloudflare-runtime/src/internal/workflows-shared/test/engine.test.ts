// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, it, vi } from "vitest";
import workerdUnsafe from "workerd:unsafe";
import { DEFAULT_STEP_LIMIT, InstanceEvent, InstanceStatus } from "../index.ts";
import { ABORT_REASONS, isAbortError } from "../lib/errors.ts";
import { setTestWorkflowCallback } from "./test-entry.ts";
import { runWorkflow, runWorkflowAndAwait } from "./utils.ts";
import type {
  DatabaseInstance,
  DatabaseVersion,
  DatabaseWorkflow,
  EngineLogs,
} from "../engine.ts";
import type {
  RollbackContext,
  RollbackFn,
  WorkflowStepRollbackOptions,
} from "../lib/rollback.ts";
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";

afterEach(async () => {
  await workerdUnsafe.abortAllDurableObjects();
});

describe("Engine", () => {
  it("should not retry after NonRetryableError is thrown", async ({
    expect,
  }) => {
    const instanceId = "NON-RETRYABLE-ERROR";
    const engineId = env.ENGINE.idFromName(instanceId);

    await runWorkflow(instanceId, async (_event, step) => {
      await step.do("should only have one retry", async () => {
        throw new NonRetryableError("Should only retry once");
      });
    });

    await vi.waitUntil(
      async () => {
        try {
          const logs = (await env.ENGINE.get(
            engineId,
          ).readLogs()) as EngineLogs;
          return logs.logs.some(
            (val) => val.event === InstanceEvent.WORKFLOW_FAILURE,
          );
        } catch (e) {
          // DO may still be aborting — retry
          if (isAbortError(e)) {
            return false;
          }
          throw e;
        }
      },
      { timeout: 5000 },
    );

    const logs = (await env.ENGINE.get(engineId).readLogs()) as EngineLogs;

    expect(
      logs.logs.filter((val) => val.event === InstanceEvent.ATTEMPT_START),
    ).toHaveLength(1);
  });

  it("should preserve NonRetryableError message when compat flag is enabled", async ({
    expect,
  }) => {
    const instanceId = "NON-RETRYABLE-PRESERVE-MSG";
    const engineId = env.ENGINE.idFromName(instanceId);
    const engineStub = env.ENGINE.get(engineId);

    vi.stubGlobal("Cloudflare", {
      compatibilityFlags: {
        workflows_preserve_non_retryable_error_message: true,
      },
    });

    try {
      setTestWorkflowCallback(async (_event, step) => {
        await step.do("failing-step", async () => {
          throw new NonRetryableError("my custom error message");
        });
      });

      await engineStub
        .init(
          12346,
          {} as DatabaseWorkflow,
          {} as DatabaseVersion,
          { id: instanceId } as DatabaseInstance,
          { payload: {}, timestamp: new Date(), instanceId, workflowName: "" },
        )
        .catch(() => {});

      await vi.waitUntil(
        async () => {
          try {
            const logs = (await env.ENGINE.get(
              engineId,
            ).readLogs()) as EngineLogs;
            return logs.logs.some(
              (val) => val.event === InstanceEvent.WORKFLOW_FAILURE,
            );
          } catch (e) {
            if (isAbortError(e)) {
              return false;
            }
            throw e;
          }
        },
        { timeout: 3000 },
      );

      const logs = (await env.ENGINE.get(engineId).readLogs()) as EngineLogs;

      const workflowFailure = logs.logs.find(
        (val) => val.event === InstanceEvent.WORKFLOW_FAILURE,
      );
      expect(workflowFailure?.metadata.error).toEqual({
        name: "NonRetryableError",
        message: "my custom error message",
      });

      const attemptFailure = logs.logs.find(
        (val) => val.event === InstanceEvent.ATTEMPT_FAILURE,
      );
      expect(attemptFailure?.metadata.error).toEqual({
        name: "NonRetryableError",
        message: "my custom error message",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should not error out if step fails but is try-catched", async ({
    expect,
  }) => {
    const engineStub = await runWorkflow(
      "MOCK-INSTANCE-ID-TRY-CATCH",
      async (_event, step) => {
        try {
          await step.do(
            "always errors out",
            {
              retries: {
                limit: 0,
                delay: 1000,
              },
            },
            async () => {
              throw new Error("Step errors out");
            },
          );
        } catch {}
        return "finished";
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event == InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;

    expect(
      logs.logs.some((val) => val.event == InstanceEvent.WORKFLOW_SUCCESS),
    ).toBe(true);

    expect(
      logs.logs.filter((val) => val.event == InstanceEvent.ATTEMPT_FAILURE),
    ).toHaveLength(1);
  });

  it("waitForEvent should receive events while active", async ({ expect }) => {
    const engineStub = await runWorkflow(
      "MOCK-INSTANCE-ID-WAIT-FOR-EVENT",
      async (_, step) => {
        return await step.waitForEvent("i'm a event!", {
          type: "event-type-1",
          timeout: "10 seconds",
        });
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some((val) => val.event === InstanceEvent.WAIT_START);
      },
      { timeout: 5000 },
    );

    await engineStub.receiveEvent({
      type: "event-type-1",
      timestamp: new Date(),
      payload: {},
    });

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    expect(logs.logs.some((v) => v.event === InstanceEvent.WAIT_START)).toBe(
      true,
    );
    expect(
      logs.logs.some((v) => v.event === InstanceEvent.WORKFLOW_SUCCESS),
    ).toBe(true);
  });

  it("waitForEvent should receive events even if not active", async ({
    expect,
  }) => {
    const engineStub = await runWorkflow(
      "MOCK-INSTANCE-ID-WAIT-FOR-EVENT-NOT-ACTIVE",
      async (_, step) => {
        return await step.waitForEvent("i'm a event!", {
          type: "event-type-1",
          timeout: "10 seconds",
        });
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some((val) => val.event === InstanceEvent.WAIT_START);
      },
      { timeout: 5000 },
    );

    try {
      await runInDurableObject(engineStub, async (engine) => {
        await engine.abort("kabooom");
      });
    } catch {
      // supposed to error out
    }

    // Get a new stub since we've just aborted the durable object
    const newStub = env.ENGINE.get(
      env.ENGINE.idFromName("MOCK-INSTANCE-ID-WAIT-FOR-EVENT-NOT-ACTIVE"),
    );

    await newStub.receiveEvent({
      type: "event-type-1",
      timestamp: new Date(),
      payload: {},
    });

    await vi.waitUntil(
      async () => {
        const logs = (await newStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await newStub.readLogs()) as EngineLogs;
    expect(logs.logs.some((v) => v.event === InstanceEvent.WAIT_START)).toBe(
      true,
    );
    expect(
      logs.logs.some((v) => v.event === InstanceEvent.WORKFLOW_SUCCESS),
    ).toBe(true);
  });

  it("waitForEvent should not deliver events to timed-out events with the same type", async ({
    expect,
  }) => {
    const instanceId = "WAIT-FOR-EVENT-STALE-WAITER";
    const engineStub = await runWorkflow(instanceId, async (_, step) => {
      const results: Array<{
        iteration: number;
        received: boolean;
      }> = [];

      for (let i = 1; i <= 3; i++) {
        try {
          await step.waitForEvent(`my-event-waiter-${i}`, {
            type: "my-event",
            timeout: 500,
          });
          results.push({ iteration: i, received: true });
        } catch {
          results.push({ iteration: i, received: false });
        }
      }

      return { results };
    });

    // 1st waitForEvent iteration - should receive event
    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return (
          logs.logs.filter((val) => val.event === InstanceEvent.WAIT_START)
            .length >= 1
        );
      },
      { timeout: 5000 },
    );

    await engineStub.receiveEvent({
      type: "my-event",
      timestamp: new Date(),
      payload: { iteration: 1 },
    });

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return (
          logs.logs.filter((val) => val.event === InstanceEvent.WAIT_START)
            .length >= 2
        );
      },
      { timeout: 5000 },
    );

    // 2nd waitForEvent iteration - should timeout (500ms)
    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WAIT_TIMED_OUT,
        );
      },
      { timeout: 5000 },
    );

    // 3rd waitForEvent iteration - should receive event
    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return (
          logs.logs.filter((val) => val.event === InstanceEvent.WAIT_START)
            .length >= 3
        );
      },
      { timeout: 5000 },
    );

    await engineStub.receiveEvent({
      type: "my-event",
      timestamp: new Date(),
      payload: { iteration: 3 },
    });

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    // Iterations 1 and 3 received events; iteration 2 timed out
    expect(
      logs.logs.filter((val) => val.event === InstanceEvent.WAIT_COMPLETE),
    ).toHaveLength(2);
    expect(
      logs.logs.filter((val) => val.event === InstanceEvent.WAIT_TIMED_OUT),
    ).toHaveLength(1);
  });

  it("should restore state from storage when accountId is undefined", async ({
    expect,
  }) => {
    const instanceId = "RESTORE-TEST-INSTANCE";
    const accountId = 12345;
    const workflow: DatabaseWorkflow = {
      name: "test-workflow",
      id: "workflow-123",
      created_on: new Date().toISOString(),
      modified_on: new Date().toISOString(),
      script_name: "test-script",
      class_name: "TestWorkflow",
      triggered_on: null,
    };
    const version: DatabaseVersion = {
      id: "version-123",
      class_name: "TestWorkflow",
      created_on: new Date().toISOString(),
      modified_on: new Date().toISOString(),
      workflow_id: workflow.id,
      mutable_pipeline_id: "pipeline-123",
    };
    const instance: DatabaseInstance = {
      id: instanceId,
      created_on: new Date().toISOString(),
      modified_on: new Date().toISOString(),
      workflow_id: workflow.id,
      version_id: version.id,
      status: InstanceStatus.Running,
      started_on: new Date().toISOString(),
      ended_on: null,
    };
    const event = {
      payload: {},
      timestamp: new Date(),
      instanceId: instanceId,
      workflowName: "",
    };

    const engineStub = await runWorkflow(instanceId, async () => {
      return "test";
    });

    try {
      await runInDurableObject(engineStub, async (engine) => {
        await engine.init(accountId, workflow, version, instance, event);
        await engine.setStatus(accountId, instanceId, InstanceStatus.Running);
        await engine.abort(ABORT_REASONS.GRACE_PERIOD_COMPLETE);
      });
    } catch (e) {
      // Expected - abort throws to break the DO
      if (!isAbortError(e)) {
        throw e;
      }
    }

    const engineId = env.ENGINE.idFromName(instanceId);
    const restartedStub = env.ENGINE.get(engineId);

    const status = await runInDurableObject(restartedStub, (engine) => {
      return engine.getStatus();
    });

    expect(status).toBe(InstanceStatus.Running);

    const logs = (await restartedStub.readLogs()) as EngineLogs;
    expect(
      logs.logs.some((log) => log.event === InstanceEvent.WORKFLOW_START),
    ).toBe(true);
  });

  it("should complete a step that returns a large Uint8Array without SQLITE_TOOBIG", async ({
    expect,
  }) => {
    // Regression: JSON.stringify(Uint8Array) encodes each byte as a numeric key,
    // producing a string far larger than byteLength. A 200 KB Uint8Array → ~2 MB JSON
    // → SQLITE_TOOBIG. writeLog must use a replacer to sanitize TypedArrays.
    const instanceId = "LARGE-UINT8ARRAY-RESULT";
    const engineId = env.ENGINE.idFromName(instanceId);
    const engineStub = env.ENGINE.get(engineId);

    await runWorkflowAndAwait(instanceId, async (_event, step) => {
      await step.do("large-binary-step", async () => {
        return new Uint8Array(200_000); // ~200 KB, triggers SQLITE_TOOBIG without fix
      });
    });

    const logs = (await engineStub.readLogs()) as EngineLogs;
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_SUCCESS),
    ).toBe(true);
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_FAILURE),
    ).toBe(false);
  });

  it("should complete a step that returns an object containing a large Uint8Array without SQLITE_TOOBIG", async ({
    expect,
  }) => {
    // Regression: nested TypedArrays inside objects also cause SQLITE_TOOBIG without
    // the JSON.stringify replacer, since sanitization must be recursive.
    const instanceId = "NESTED-UINT8ARRAY-RESULT";
    const engineId = env.ENGINE.idFromName(instanceId);
    const engineStub = env.ENGINE.get(engineId);

    await runWorkflowAndAwait(instanceId, async (_event, step) => {
      await step.do("nested-binary-step", async () => {
        return { payload: new Uint8Array(200_000), label: "test" };
      });
    });

    const logs = (await engineStub.readLogs()) as EngineLogs;
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_SUCCESS),
    ).toBe(true);
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_FAILURE),
    ).toBe(false);
  });

  describe("step limits", () => {
    it("should enforce step limit when exceeded", async ({ expect }) => {
      const stepLimit = 3;
      const instanceId = "STEP-LIMIT-EXCEEDED";
      const engineId = env.ENGINE.idFromName(instanceId);
      const engineStub = env.ENGINE.get(engineId);

      await runInDurableObject(engineStub, (engine) => {
        engine.stepLimit = stepLimit;
      });

      setTestWorkflowCallback(async (_event, step) => {
        for (let i = 0; i < stepLimit + 1; i++) {
          await step.do(`step-${i}`, async () => `result-${i}`);
        }
      });

      await engineStub.init(
        12346,
        {} as DatabaseWorkflow,
        {} as DatabaseVersion,
        { id: instanceId } as DatabaseInstance,
        { payload: {}, timestamp: new Date(), instanceId, workflowName: "" },
      );

      const logs = (await engineStub.readLogs()) as EngineLogs;

      expect(
        logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_FAILURE),
      ).toBe(true);
    });

    it("should succeed when steps are exactly at the limit", async ({
      expect,
    }) => {
      const stepLimit = 3;
      const instanceId = "STEP-LIMIT-AT-LIMIT";
      const engineId = env.ENGINE.idFromName(instanceId);
      const engineStub = env.ENGINE.get(engineId);

      await runInDurableObject(engineStub, (engine) => {
        engine.stepLimit = stepLimit;
      });

      setTestWorkflowCallback(async (_event, step) => {
        for (let i = 0; i < stepLimit; i++) {
          await step.do(`step-${i}`, async () => `result-${i}`);
        }
        return "done";
      });

      await engineStub.init(
        12346,
        {} as DatabaseWorkflow,
        {} as DatabaseVersion,
        { id: instanceId } as DatabaseInstance,
        { payload: {}, timestamp: new Date(), instanceId, workflowName: "" },
      );

      const logs = (await engineStub.readLogs()) as EngineLogs;

      expect(
        logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_SUCCESS),
      ).toBe(true);
      expect(
        logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_FAILURE),
      ).toBe(false);
    });

    it("should use DEFAULT_STEP_LIMIT when no limit is configured", async ({
      expect,
    }) => {
      const engineId = env.ENGINE.idFromName("STEP-LIMIT-DEFAULT");
      const freshStub = env.ENGINE.get(engineId);

      const stepLimit = await runInDurableObject(
        freshStub,
        (engine) => engine.stepLimit,
      );

      expect(stepLimit).toBe(DEFAULT_STEP_LIMIT);
    });
  });

  describe("lifecycle methods", () => {
    it.for([
      InstanceStatus.Complete,
      InstanceStatus.Errored,
      InstanceStatus.Terminated,
    ])(
      "should throw when calling terminate on instance in finite state: %s",
      async (finiteStatus, { expect }) => {
        const engineStub = await runWorkflowAndAwait(
          `TERMINATE-${finiteStatus}-INSTANCE`,
          async () => "done",
        );

        // If not Complete, manually set the status
        if (finiteStatus !== InstanceStatus.Complete) {
          await runInDurableObject(engineStub, async (_engine, state) => {
            await state.storage.put("ENGINE_STATUS", finiteStatus);
          });
        }

        await expect(
          runInDurableObject(engineStub, async (engine) => {
            await engine.changeInstanceStatus("terminate");
          }),
        ).rejects.toThrow(
          "Cannot terminate instance since its on a finite state",
        );
      },
    );

    it.for([
      InstanceStatus.Complete,
      InstanceStatus.Errored,
      InstanceStatus.Terminated,
      InstanceStatus.Running,
      InstanceStatus.Paused,
    ])(
      "should restart workflow from status: %s",
      async (initialStatus, { expect }) => {
        const instanceId = `RESTART-${initialStatus}-INSTANCE`;
        const engineId = env.ENGINE.idFromName(instanceId);

        const engineStub = await runWorkflowAndAwait(
          instanceId,
          async (_event: unknown, step: WorkflowStep) => {
            await step.do("test-step", async () => "step-result");
            return "done";
          },
        );

        // Set the status to initialStatus
        await runInDurableObject(engineStub, async (_engine, state) => {
          await state.storage.put("ENGINE_STATUS", initialStatus);
        });

        try {
          await runInDurableObject(engineStub, async (engine) => {
            await engine.changeInstanceStatus("restart");
          });
        } catch (e) {
          // Expected - abort throws to break the DO
          if (!isAbortError(e)) {
            throw e;
          }
        }

        const restartedStub = env.ENGINE.get(engineId);

        await runInDurableObject(restartedStub, async (engine) => {
          await engine.attemptRestart();
        });

        await vi.waitUntil(
          async () => {
            const status = await runInDurableObject(restartedStub, (engine) =>
              engine.getStatus(),
            );
            return status === InstanceStatus.Complete;
          },
          { timeout: 5000 },
        );

        // Verify the workflow ran again by checking logs
        const logs = (await restartedStub.readLogs()) as EngineLogs;

        expect(
          logs.logs.some((log) => log.event === InstanceEvent.WORKFLOW_START),
        ).toBe(true);

        expect(
          logs.logs.some((log) => log.event === InstanceEvent.STEP_START),
        ).toBe(true);

        expect(
          logs.logs.some((log) => log.event === InstanceEvent.WORKFLOW_SUCCESS),
        ).toBe(true);
      },
    );

    it("should restart from a specific step and preserve earlier results", async ({
      expect,
    }) => {
      const instanceId = "RESTART-FROM-STEP";
      const engineId = env.ENGINE.idFromName(instanceId);

      const engineStub = await runWorkflowAndAwait(
        instanceId,
        async (_event: unknown, step: WorkflowStep) => {
          const a = await step.do("step-a", async () => "result-a");
          const b = await step.do("step-b", async () => "result-b");
          return { a, b };
        },
      );

      const statusBefore = await runInDurableObject(engineStub, (engine) =>
        engine.getStatus(),
      );
      expect(statusBefore).toBe(InstanceStatus.Complete);

      try {
        await runInDurableObject(engineStub, async (engine) => {
          await engine.changeInstanceStatus("restart", {
            name: "step-b",
          });
        });
      } catch (e) {
        if (!isAbortError(e)) {
          throw e;
        }
      }

      const restartedStub = env.ENGINE.get(engineId);

      await runInDurableObject(restartedStub, async (engine) => {
        await engine.attemptRestart();
      });

      await vi.waitUntil(
        async () => {
          const status = await runInDurableObject(restartedStub, (engine) =>
            engine.getStatus(),
          );
          return status === InstanceStatus.Complete;
        },
        { timeout: 5000 },
      );

      const logs = (await restartedStub.readLogs()) as EngineLogs;

      // step-a should still have its cached result from the first run
      const stepSuccessLogs = logs.logs.filter(
        (log) => log.event === InstanceEvent.STEP_SUCCESS,
      );
      expect(stepSuccessLogs.length).toBeGreaterThanOrEqual(2);

      expect(
        logs.logs.some((log) => log.event === InstanceEvent.WORKFLOW_SUCCESS),
      ).toBe(true);
    });

    it("should default restart from step type to step.do", async ({
      expect,
    }) => {
      const instanceId = "RESTART-FROM-STEP-DEFAULT-DO";
      const engineId = env.ENGINE.idFromName(instanceId);

      const engineStub = await runWorkflowAndAwait(
        instanceId,
        async (_event: unknown, step: WorkflowStep) => {
          const setup = await step.do("setup", async () => crypto.randomUUID());
          await step.sleep("checkpoint", 1);
          const between = await step.do("between", async () =>
            crypto.randomUUID(),
          );
          const checkpoint = await step.do("checkpoint", async () =>
            crypto.randomUUID(),
          );
          const after = await step.do("after", async () => crypto.randomUUID());
          return { setup, between, checkpoint, after };
        },
      );

      const logsBefore = (await engineStub.readLogs()) as EngineLogs;
      const stepResultsBefore = logsBefore.logs
        .filter((log) => log.event === InstanceEvent.STEP_SUCCESS)
        .map((log) => log.metadata.result);

      try {
        await runInDurableObject(engineStub, async (engine) => {
          await engine.changeInstanceStatus("restart", {
            name: "checkpoint",
          });
        });
      } catch (e) {
        if (!isAbortError(e)) {
          throw e;
        }
      }

      const restartedStub = env.ENGINE.get(engineId);

      await runInDurableObject(restartedStub, async (engine) => {
        await engine.attemptRestart();
      });

      await vi.waitUntil(
        async () => {
          const status = await runInDurableObject(restartedStub, (engine) =>
            engine.getStatus(),
          );
          return status === InstanceStatus.Complete;
        },
        { timeout: 5000 },
      );

      const logsAfter = (await restartedStub.readLogs()) as EngineLogs;
      const stepResultsAfter = logsAfter.logs
        .filter((log) => log.event === InstanceEvent.STEP_SUCCESS)
        .map((log) => log.metadata.result);

      expect(stepResultsAfter[0]).toEqual(stepResultsBefore[0]);
      expect(stepResultsAfter[1]).toEqual(stepResultsBefore[1]);
      expect(stepResultsAfter[2]).not.toEqual(stepResultsBefore[2]);
      expect(stepResultsAfter[3]).not.toEqual(stepResultsBefore[3]);
    });

    it("should throw when restarting from a non-existing step", async ({
      expect,
    }) => {
      const instanceId = "RESTART-FROM-BAD-STEP";

      const engineStub = await runWorkflowAndAwait(
        instanceId,
        async (_event: unknown, step: WorkflowStep) => {
          await step.do("step-a", async () => "result-a");
          return "done";
        },
      );

      await expect(
        runInDurableObject(engineStub, async (engine) => {
          await engine.changeInstanceStatus("restart", {
            name: "nonexistent-step",
          });
        }),
      ).rejects.toThrow("not found in execution history");
    });

    it("should pause after in-flight step.do finishes", async ({ expect }) => {
      const instanceId = "PAUSE-AFTER-DO";
      const engineId = env.ENGINE.idFromName(instanceId);

      const engineStub = await runWorkflow(instanceId, async (_event, step) => {
        await step.do("long-step", async () => {
          await scheduler.wait(500);
          return "first";
        });
        // step-2 should never run because pause takes effect after long-step
        await step.do("step-2", async () => "second");
        return "done";
      });

      // Wait for long-step to start
      await vi.waitUntil(
        async () => {
          return await runInDurableObject(engineStub, (engine) => {
            const logs = engine.readLogs() as unknown as EngineLogs;
            return logs.logs.some(
              (log) => log.event === InstanceEvent.STEP_START,
            );
          });
        },
        { timeout: 5000 },
      );

      // Request pause while long-step is in flight
      try {
        await runInDurableObject(engineStub, async (engine) => {
          await engine.changeInstanceStatus("pause");
        });
      } catch (e) {
        if (!isAbortError(e)) {
          throw e;
        }
      }

      await vi.waitUntil(
        async () => {
          try {
            return await runInDurableObject(
              env.ENGINE.get(engineId),
              async (engine) =>
                (await engine.getStatus()) === InstanceStatus.Paused,
            );
          } catch (e) {
            if (isAbortError(e)) {
              return false;
            }
            throw e;
          }
        },
        { timeout: 5000 },
      );

      const freshStub = env.ENGINE.get(engineId);
      const finalStatus = await runInDurableObject(freshStub, (engine) =>
        engine.getStatus(),
      );
      expect(finalStatus).toBe(InstanceStatus.Paused);

      // Verify long-step completed but step-2 never ran
      const logs = await runInDurableObject(freshStub, (engine) => {
        return engine.readLogs() as unknown as EngineLogs;
      });
      const stepSuccesses = logs.logs.filter(
        (log) => log.event === InstanceEvent.STEP_SUCCESS,
      );
      expect(stepSuccesses).toHaveLength(1);
    });

    it("should pause after multiple concurrent in-flight step.dos finish", async ({
      expect,
    }) => {
      const instanceId = "PAUSE-AFTER-CONCURRENT-DOS";
      const engineId = env.ENGINE.idFromName(instanceId);

      const engineStub = await runWorkflow(instanceId, async (_event, step) => {
        const [resultA, resultB] = await Promise.all([
          step.do("slow-step-a", async () => {
            await scheduler.wait(500);
            return "a-done";
          }),
          step.do("slow-step-b", async () => {
            await scheduler.wait(500);
            return "b-done";
          }),
        ]);

        // This step should never run
        await step.do("step-after-pause", async () => "should-not-run");
        return { resultA, resultB };
      });

      await vi.waitUntil(
        async () => {
          return await runInDurableObject(engineStub, (engine) => {
            const logs = engine.readLogs() as unknown as EngineLogs;
            return (
              logs.logs.filter((log) => log.event === InstanceEvent.STEP_START)
                .length >= 2
            );
          });
        },
        { timeout: 5000 },
      );

      // Request pause while both slow steps are in flight
      try {
        await runInDurableObject(engineStub, async (engine) => {
          await engine.changeInstanceStatus("pause");
        });
      } catch (e) {
        if (!isAbortError(e)) {
          throw e;
        }
      }

      await vi.waitUntil(
        async () => {
          try {
            return await runInDurableObject(
              env.ENGINE.get(engineId),
              async (engine) =>
                (await engine.getStatus()) === InstanceStatus.Paused,
            );
          } catch (e) {
            if (isAbortError(e)) {
              return false;
            }
            throw e;
          }
        },
        { timeout: 5000 },
      );

      const freshStub = env.ENGINE.get(engineId);
      const finalStatus = await runInDurableObject(freshStub, (engine) =>
        engine.getStatus(),
      );
      expect(finalStatus).toBe(InstanceStatus.Paused);

      // Both concurrent steps should have completed, but step-after-pause should not
      const logs = await runInDurableObject(freshStub, (engine) => {
        return engine.readLogs() as unknown as EngineLogs;
      });
      const stepSuccesses = logs.logs.filter(
        (log) => log.event === InstanceEvent.STEP_SUCCESS,
      );
      expect(stepSuccesses).toHaveLength(2);
    });

    it("should unblock concurrent steps blocked when resume cancels pending pause", async ({
      expect,
    }) => {
      const instanceId = "RESUME-UNBLOCKS-WAITING-STEPS";
      const engineId = env.ENGINE.idFromName(instanceId);

      const engineStub = await runWorkflow(instanceId, async (_event, step) => {
        const [slowResult, fastResult] = await Promise.all([
          step.do("slow-step", async () => {
            await scheduler.wait(1000);
            return "slow-done";
          }),
          step.do("fast-step", async () => {
            return "fast-done";
          }),
        ]);

        await step.do("step-after-resume", async () => "after-resume");
        return { slowResult, fastResult };
      });

      await vi.waitUntil(
        async () => {
          return await runInDurableObject(engineStub, (engine) => {
            const logs = engine.readLogs() as unknown as EngineLogs;
            return logs.logs.some(
              (log) => log.event === InstanceEvent.STEP_START,
            );
          });
        },
        { timeout: 5000 },
      );

      await runInDurableObject(engineStub, async (engine) => {
        await engine.changeInstanceStatus("pause");
      });

      await vi.waitUntil(
        async () =>
          runInDurableObject(
            env.ENGINE.get(engineId),
            async (engine) =>
              (await engine.getStatus()) === InstanceStatus.WaitingForPause,
          ),
        { timeout: 5000 },
      );

      // Resume before slow-step finishes
      await runInDurableObject(engineStub, async (engine) => {
        await engine.changeInstanceStatus("resume");
      });

      // Verify status goes back to Running
      const statusAfterResume = await runInDurableObject(
        env.ENGINE.get(engineId),
        (engine) => engine.getStatus(),
      );
      expect(statusAfterResume).toBe(InstanceStatus.Running);

      await vi.waitUntil(
        async () =>
          runInDurableObject(
            env.ENGINE.get(engineId),
            async (engine) =>
              (await engine.getStatus()) === InstanceStatus.Complete,
          ),
        { timeout: 5000 },
      );

      const freshStub = env.ENGINE.get(engineId);
      const finalStatus = await runInDurableObject(freshStub, (engine) =>
        engine.getStatus(),
      );
      expect(finalStatus).toBe(InstanceStatus.Complete);

      // All three steps should have completed
      const logs = await runInDurableObject(freshStub, (engine) => {
        return engine.readLogs() as unknown as EngineLogs;
      });
      const stepSuccesses = logs.logs.filter(
        (log) => log.event === InstanceEvent.STEP_SUCCESS,
      );
      expect(stepSuccesses).toHaveLength(3);
    });

    it("should pause during a step.sleep, then resume and complete", async ({
      expect,
    }) => {
      const instanceId = "PAUSE-DURING-SLEEP-RESUME";
      const engineId = env.ENGINE.idFromName(instanceId);

      const engineStub = await runWorkflow(instanceId, async (_event, step) => {
        await step.do("first-step", async () => "first-done");

        await step.sleep("short-sleep", "1 second");

        await step.do("after-sleep", async () => "after-sleep-done");
        return "done";
      });

      // Wait for the first step to complete (workflow is now in the sleep)
      await vi.waitUntil(
        async () => {
          try {
            return await runInDurableObject(engineStub, (engine) => {
              const logs = engine.readLogs() as unknown as EngineLogs;
              return logs.logs.some(
                (log) => log.event === InstanceEvent.STEP_SUCCESS,
              );
            });
          } catch (e) {
            if (isAbortError(e)) {
              return false;
            }
            throw e;
          }
        },
        { timeout: 5000 },
      );

      // Request pause while in step.sleep — should pause immediately
      try {
        await runInDurableObject(engineStub, async (engine) => {
          await engine.changeInstanceStatus("pause");
        });
      } catch (e) {
        if (!isAbortError(e)) {
          throw e;
        }
      }

      await vi.waitUntil(
        async () => {
          try {
            return await runInDurableObject(
              env.ENGINE.get(engineId),
              async (engine) =>
                (await engine.getStatus()) === InstanceStatus.Paused,
            );
          } catch (e) {
            if (isAbortError(e)) {
              return false;
            }
            throw e;
          }
        },
        { timeout: 5000 },
      );

      expect(
        await runInDurableObject(env.ENGINE.get(engineId), (engine) =>
          engine.getStatus(),
        ),
      ).toBe(InstanceStatus.Paused);

      // Only the first step should have succeeded — sleep was interrupted
      const logsBeforeResume = await runInDurableObject(
        env.ENGINE.get(engineId),
        (engine) => engine.readLogs() as unknown as EngineLogs,
      );
      expect(
        logsBeforeResume.logs.filter(
          (log) => log.event === InstanceEvent.STEP_SUCCESS,
        ),
      ).toHaveLength(1);

      // Resume the workflow
      try {
        await runInDurableObject(env.ENGINE.get(engineId), async (engine) => {
          await engine.changeInstanceStatus("resume");
        });
      } catch (e) {
        if (!isAbortError(e)) {
          throw e;
        }
      }

      // Wait for the workflow to complete — sleep should finish and after-sleep step should run
      await vi.waitUntil(
        async () => {
          try {
            return await runInDurableObject(
              env.ENGINE.get(engineId),
              async (engine) =>
                (await engine.getStatus()) === InstanceStatus.Complete,
            );
          } catch (e) {
            if (isAbortError(e)) {
              return false;
            }
            throw e;
          }
        },
        { timeout: 5000 },
      );

      const finalLogs = await runInDurableObject(
        env.ENGINE.get(engineId),
        (engine) => engine.readLogs() as unknown as EngineLogs,
      );
      const stepSuccesses = finalLogs.logs.filter(
        (log) => log.event === InstanceEvent.STEP_SUCCESS,
      );
      // first-step + after-sleep = 2 step successes
      expect(stepSuccesses).toHaveLength(2);
    });

    it("should pause during a waitForEvent, then resume and complete", async ({
      expect,
    }) => {
      const instanceId = "PAUSE-DURING-WAIT-FOR-EVENT";
      const engineId = env.ENGINE.idFromName(instanceId);

      const engineStub = await runWorkflow(instanceId, async (_event, step) => {
        await step.do("first-step", async () => "first-done");

        await step.waitForEvent("wait-for-signal", {
          type: "continue",
          timeout: "30 seconds",
        });

        await step.do("after-event", async () => "after-event-done");
        return "done";
      });

      // Wait for the first step to complete (workflow is now waiting for event)
      await vi.waitUntil(
        async () => {
          try {
            return await runInDurableObject(engineStub, (engine) => {
              const logs = engine.readLogs() as unknown as EngineLogs;
              return logs.logs.some(
                (log) => log.event === InstanceEvent.WAIT_START,
              );
            });
          } catch (e) {
            if (isAbortError(e)) {
              return false;
            }
            throw e;
          }
        },
        { timeout: 5000 },
      );

      // Request pause while in waitForEvent
      try {
        await runInDurableObject(engineStub, async (engine) => {
          await engine.changeInstanceStatus("pause");
        });
      } catch (e) {
        if (!isAbortError(e)) {
          throw e;
        }
      }

      await vi.waitUntil(
        async () => {
          try {
            return await runInDurableObject(
              env.ENGINE.get(engineId),
              async (engine) =>
                (await engine.getStatus()) === InstanceStatus.Paused,
            );
          } catch (e) {
            if (isAbortError(e)) {
              return false;
            }
            throw e;
          }
        },
        { timeout: 5000 },
      );

      expect(
        await runInDurableObject(env.ENGINE.get(engineId), (engine) =>
          engine.getStatus(),
        ),
      ).toBe(InstanceStatus.Paused);

      // Resume the workflow
      try {
        await runInDurableObject(env.ENGINE.get(engineId), async (engine) => {
          await engine.changeInstanceStatus("resume");
        });
      } catch (e) {
        if (!isAbortError(e)) {
          throw e;
        }
      }

      // Send the event after resume
      await runInDurableObject(env.ENGINE.get(engineId), async (engine) => {
        await engine.receiveEvent({
          timestamp: new Date(),
          payload: { done: true },
          type: "continue",
        });
      });

      // Wait for the workflow to complete
      await vi.waitUntil(
        async () => {
          try {
            return await runInDurableObject(
              env.ENGINE.get(engineId),
              async (engine) =>
                (await engine.getStatus()) === InstanceStatus.Complete,
            );
          } catch (e) {
            if (isAbortError(e)) {
              return false;
            }
            throw e;
          }
        },
        { timeout: 5000 },
      );

      const finalLogs = await runInDurableObject(
        env.ENGINE.get(engineId),
        (engine) => engine.readLogs() as unknown as EngineLogs,
      );
      const stepSuccesses = finalLogs.logs.filter(
        (log) => log.event === InstanceEvent.STEP_SUCCESS,
      );
      // first-step + after-event = 2 step successes
      expect(stepSuccesses).toHaveLength(2);
    });

    it("should transition WaitingForPause to Paused on init() entry", async ({
      expect,
    }) => {
      const instanceId = "WAITING-FOR-PAUSE-INIT";

      const engineStub = await runWorkflowAndAwait(
        instanceId,
        async () => "done",
      );

      // Manually set status to WaitingForPause (simulating a DO restart scenario)
      await runInDurableObject(engineStub, async (_engine, state) => {
        await state.storage.put(
          "ENGINE_STATUS",
          InstanceStatus.WaitingForPause,
        );
      });

      // Now call init() — it should detect WaitingForPause and transition to Paused
      await runInDurableObject(engineStub, async (engine) => {
        // Reset isRunning so init() doesn't short-circuit
        engine.isRunning = false;
        await engine.init(
          12346,
          {} as DatabaseWorkflow,
          {} as DatabaseVersion,
          { id: instanceId } as DatabaseInstance,
          {
            payload: {},
            timestamp: new Date(),
            instanceId,
            workflowName: "",
          },
        );
      });

      const status = await runInDurableObject(engineStub, (engine) =>
        engine.getStatus(),
      );
      expect(status).toBe(InstanceStatus.Paused);
    });
  });
});

// RPC-stubbed rollback fns can't reliably mutate test-scope closures —
// assert via engine log events instead.
describe("Rollback", () => {
  async function readLogsAfter(
    stub: { readLogs(): Promise<EngineLogs> | EngineLogs },
    predicate: (logs: EngineLogs) => boolean,
    timeout = 5000,
  ): Promise<EngineLogs> {
    await vi.waitUntil(
      async () => predicate((await stub.readLogs()) as EngineLogs),
      { timeout },
    );
    return (await stub.readLogs()) as EngineLogs;
  }

  function targetsOf(
    logs: EngineLogs,
    event: InstanceEvent,
  ): Array<string | null> {
    return logs.logs.filter((l) => l.event === event).map((l) => l.target);
  }

  function countOf(logs: EngineLogs, event: InstanceEvent): number {
    return logs.logs.filter((l) => l.event === event).length;
  }

  function doWithRollback<T>(
    step: WorkflowStep,
    name: string,
    callback: (ctx: unknown) => Promise<T>,
    options: WorkflowStepRollbackOptions,
  ): Promise<unknown>;
  function doWithRollback<T>(
    step: WorkflowStep,
    name: string,
    config: WorkflowStepConfig,
    callback: (ctx: unknown) => Promise<T>,
    options: WorkflowStepRollbackOptions,
  ): Promise<unknown>;
  function doWithRollback<T>(
    step: WorkflowStep,
    name: string,
    configOrCallback: WorkflowStepConfig | ((ctx: unknown) => Promise<T>),
    callbackOrOptions:
      | ((ctx: unknown) => Promise<T>)
      | WorkflowStepRollbackOptions,
    options?: WorkflowStepRollbackOptions,
  ): Promise<unknown> {
    if (typeof configOrCallback === "function") {
      // @ts-expect-error -- rollback options are not in workers-types yet
      return step.do(name, configOrCallback, callbackOrOptions);
    }
    // @ts-expect-error -- rollback options are not in workers-types yet
    return step.do(name, configOrCallback, callbackOrOptions, options);
  }

  async function noopRollback(_ctx: RollbackContext): Promise<void> {}

  function rollbackOptions(
    fn: RollbackFn = noopRollback,
  ): WorkflowStepRollbackOptions {
    return { rollback: fn };
  }

  function rollbackOptionsWithConfig(
    rollbackConfig: WorkflowStepConfig,
    fn: RollbackFn = noopRollback,
  ): WorkflowStepRollbackOptions {
    return { rollback: fn, rollbackConfig };
  }

  it("runs rollback fns in LIFO order on workflow failure", async ({
    expect,
  }) => {
    const stub = await runWorkflowAndAwait("RB-LIFO", async (_e, step) => {
      await doWithRollback(
        step,
        "step-1",
        async () => "out-1",
        rollbackOptions(),
      );
      await doWithRollback(
        step,
        "step-2",
        async () => "out-2",
        rollbackOptions(),
      );
      await doWithRollback(
        step,
        "step-3",
        async () => "out-3",
        rollbackOptions(),
      );
      throw new Error("boom");
    });
    const logs = await readLogsAfter(stub, (l) =>
      l.logs.some((r) => r.event === InstanceEvent.ROLLBACK_COMPLETE),
    );
    expect(targetsOf(logs, InstanceEvent.ROLLBACK_STEP_SUCCESS)).toEqual([
      "step-3-1",
      "step-2-1",
      "step-1-1",
    ]);
    expect(targetsOf(logs, InstanceEvent.ROLLBACK_ATTEMPT_SUCCESS)).toEqual([
      "step-3-1",
      "step-2-1",
      "step-1-1",
    ]);
    expect(countOf(logs, InstanceEvent.ROLLBACK_FAILED)).toBe(0);
  });

  it("runs parallel rollbacks in reverse step start order", async ({
    expect,
  }) => {
    let firstStarted: () => void = () => {};
    let firstMayFinish: () => void = () => {};
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstMayFinishPromise = new Promise<void>((resolve) => {
      firstMayFinish = resolve;
    });

    const stub = await runWorkflowAndAwait("RB-PARALLEL", async (_e, step) => {
      const first = doWithRollback(
        step,
        "first",
        async () => {
          firstStarted();
          await firstMayFinishPromise;
          await scheduler.wait(50);
          return "out-1";
        },
        rollbackOptions(),
      );
      await firstStartedPromise;

      const second = doWithRollback(
        step,
        "second",
        async () => {
          firstMayFinish();
          return "out-2";
        },
        rollbackOptions(),
      );

      await Promise.all([first, second]);
      throw new Error("boom");
    });
    const logs = await readLogsAfter(stub, (l) =>
      l.logs.some((r) => r.event === InstanceEvent.ROLLBACK_COMPLETE),
    );
    expect(targetsOf(logs, InstanceEvent.ROLLBACK_STEP_SUCCESS)).toEqual([
      "second-1",
      "first-1",
    ]);
  });

  it("uses rollbackConfig when executing rollback", async ({ expect }) => {
    const rollbackConfig = {
      retries: { limit: 0, delay: 0, backoff: "constant" },
      timeout: "30 seconds",
    } satisfies WorkflowStepConfig;
    const stub = await runWorkflowAndAwait("RB-CONFIG", async (_e, step) => {
      await doWithRollback(
        step,
        "configured-step",
        async () => "out",
        rollbackOptionsWithConfig(rollbackConfig),
      );
      throw new Error("boom");
    });
    const logs = await readLogsAfter(stub, (l) =>
      l.logs.some((r) => r.event === InstanceEvent.ROLLBACK_COMPLETE),
    );
    expect(
      logs.logs.find((l) => l.event === InstanceEvent.ROLLBACK_STEP_START)
        ?.metadata,
    ).toMatchObject({ config: rollbackConfig });
  });

  it("passes rollback context to rollback fn", async ({ expect }) => {
    const stub = await runWorkflowAndAwait("RB-CONTEXT", async (_e, step) => {
      await doWithRollback(
        step,
        "ctx-step",
        async () => "out",
        rollbackOptions(async (ctx) => {
          if (
            ctx.error.name !== "Error" ||
            ctx.error.message !== "boom" ||
            ctx.output !== "out" ||
            ctx.ctx.step.name !== "ctx-step" ||
            ctx.ctx.step.count !== 1 ||
            ctx.stepName !== "ctx-step-1"
          ) {
            throw new Error("unexpected rollback context");
          }
        }),
      );
      throw new Error("boom");
    });
    const logs = await readLogsAfter(stub, (l) =>
      l.logs.some((r) => r.event === InstanceEvent.ROLLBACK_COMPLETE),
    );
    expect(targetsOf(logs, InstanceEvent.ROLLBACK_STEP_SUCCESS)).toEqual([
      "ctx-step-1",
    ]);
  });

  it("runs rollback for failed step", async ({ expect }) => {
    const stub = await runWorkflowAndAwait(
      "RB-FAILED-STEP",
      async (_e, step) => {
        await doWithRollback(
          step,
          "failed-step",
          { retries: { limit: 0, delay: 0, backoff: "constant" } },
          async () => {
            throw new Error("step-boom");
          },
          rollbackOptions(async (ctx) => {
            if (
              ctx.error.message !== "step-boom" ||
              ctx.output !== undefined ||
              ctx.ctx.step.name !== "failed-step" ||
              ctx.ctx.step.count !== 1 ||
              ctx.stepName !== "failed-step-1"
            ) {
              throw new Error("unexpected failed-step rollback context");
            }
          }),
        );
      },
    );
    const logs = await readLogsAfter(stub, (l) =>
      l.logs.some((r) => r.event === InstanceEvent.ROLLBACK_COMPLETE),
    );
    const rollbackStepTargets = targetsOf(
      logs,
      InstanceEvent.ROLLBACK_STEP_SUCCESS,
    );
    const stepFailureTargets = targetsOf(logs, InstanceEvent.STEP_FAILURE);

    expect(rollbackStepTargets).toEqual(["failed-step-1"]);
    expect(stepFailureTargets).toContain("failed-step-1");
  });

  it("only runs rollbacks for steps with a registered fn", async ({
    expect,
  }) => {
    const stub = await runWorkflowAndAwait("RB-PARTIAL", async (_e, step) => {
      await step.do("plain-step", async () => "v1");
      await doWithRollback(
        step,
        "step-with-rollback",
        async () => "v2",
        rollbackOptions(),
      );
      await step.do("plain-step-after", async () => "v3");
      throw new Error("boom");
    });
    const logs = await readLogsAfter(stub, (l) =>
      l.logs.some((r) => r.event === InstanceEvent.ROLLBACK_COMPLETE),
    );
    expect(targetsOf(logs, InstanceEvent.ROLLBACK_STEP_SUCCESS)).toEqual([
      "step-with-rollback-1",
    ]);
    expect(
      logs.logs.find((l) => l.event === InstanceEvent.ROLLBACK_START)?.metadata,
    ).toMatchObject({ totalSteps: 1 });
  });

  it("stops at the first failing rollback and logs ROLLBACK_FAILED", async ({
    expect,
  }) => {
    const stub = await runWorkflowAndAwait("RB-FAILS", async (_e, step) => {
      await doWithRollback(step, "step-1", async () => "v1", rollbackOptions());
      await doWithRollback(
        step,
        "step-2",
        async () => "v2",
        rollbackOptionsWithConfig(
          { retries: { limit: 0, delay: 0, backoff: "constant" } },
          async () => {
            throw new Error("rollback-boom");
          },
        ),
      );
      await doWithRollback(step, "step-3", async () => "v3", rollbackOptions());
      throw new Error("boom");
    });
    const logs = await readLogsAfter(stub, (l) =>
      l.logs.some((r) => r.event === InstanceEvent.ROLLBACK_FAILED),
    );
    expect(targetsOf(logs, InstanceEvent.ROLLBACK_STEP_SUCCESS)).toEqual([
      "step-3-1",
    ]);
    expect(targetsOf(logs, InstanceEvent.ROLLBACK_STEP_FAILURE)).toEqual([
      "step-2-1",
    ]);
    expect(targetsOf(logs, InstanceEvent.ROLLBACK_ATTEMPT_FAILURE)).toEqual([
      "step-2-1",
    ]);
    expect(countOf(logs, InstanceEvent.ROLLBACK_COMPLETE)).toBe(0);
  });

  it("does not run rollback when workflow succeeds", async ({ expect }) => {
    const stub = await runWorkflowAndAwait("RB-NOOP", async (_e, step) => {
      await doWithRollback(step, "a", async () => "ok", rollbackOptions());
      return "done";
    });
    const logs = await readLogsAfter(stub, (l) =>
      l.logs.some((r) => r.event === InstanceEvent.WORKFLOW_SUCCESS),
    );
    expect(countOf(logs, InstanceEvent.ROLLBACK_START)).toBe(0);
  });
});
