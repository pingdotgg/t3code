// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { InstanceEvent, instanceStatusName } from "./instance.ts";
import {
  isUserTriggeredPause,
  isUserTriggeredRestart,
  isUserTriggeredTerminate,
  WorkflowError,
} from "./lib/errors.ts";
import { isValidWorkflowInstanceId } from "./lib/validators.ts";
import type {
  DatabaseInstance,
  DatabaseVersion,
  DatabaseWorkflow,
  Engine,
  EngineLogs,
} from "./engine.ts";
import type { InstanceStatus as EngineInstanceStatus } from "./instance.ts";
import type {
  WorkflowInstanceModifier,
  WorkflowIntrospectionOperation,
  WorkflowIntrospectionStreamResult,
} from "./types.ts";

type Env = {
  ENGINE: DurableObjectNamespace<Engine>;
  BINDING_NAME: string;
  WORKFLOW_NAME: string;
};

type WorkflowIntrospectionSession = {
  id: string;
  operations: Array<WorkflowIntrospectionOperation>;
  instanceIds: Array<string>;
};

// workerd may construct a fresh WorkflowBinding object for each RPC call. Store
// sessions at module scope so start/modify/get/dispose calls, and later
// WorkflowBinding.create() calls, all see the same active Workflow session.
const workflowIntrospectionSessions = new Map<
  string,
  WorkflowIntrospectionSession
>();

function getWorkflowIntrospectionSession(
  workflowName: string,
  sessionId: string,
): WorkflowIntrospectionSession {
  const session = workflowIntrospectionSessions.get(workflowName);
  if (session?.id !== sessionId) {
    throw new Error(
      `Workflow ${JSON.stringify(workflowName)} does not have an active introspection session for this introspector.`,
    );
  }
  return session;
}

function isWorkflowIntrospectionStreamResult(
  value: unknown,
): value is WorkflowIntrospectionStreamResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "__workflowIntrospectionStreamResult" in value &&
    "chunks" in value &&
    value.__workflowIntrospectionStreamResult === true &&
    Array.isArray(value.chunks)
  );
}

function createWorkflowIntrospectionReadableStream(
  result: WorkflowIntrospectionStreamResult,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of result.chunks) {
        controller.enqueue(chunk.slice());
      }
      controller.close();
    },
  });
}

async function applyWorkflowIntrospectionOperation(
  modifier: WorkflowInstanceModifier,
  operation: WorkflowIntrospectionOperation,
) {
  switch (operation.type) {
    case "disableSleeps":
      await modifier.disableSleeps(operation.steps);
      break;
    case "disableRetryDelays":
      await modifier.disableRetryDelays(operation.steps);
      break;
    case "mockStepResult":
      await modifier.mockStepResult(
        operation.step,
        isWorkflowIntrospectionStreamResult(operation.stepResult)
          ? createWorkflowIntrospectionReadableStream(operation.stepResult)
          : operation.stepResult,
      );
      break;
    case "mockStepError": {
      const error = new Error(operation.error.message);
      error.name = operation.error.name;
      await modifier.mockStepError(operation.step, error, operation.times);
      break;
    }
    case "forceStepTimeout":
      await modifier.forceStepTimeout(operation.step, operation.times);
      break;
    case "mockEvent":
      await modifier.mockEvent(operation.event);
      break;
    case "forceEventTimeout":
      await modifier.forceEventTimeout(operation.step);
      break;
  }
}

// TODO(vaish): import from @cloudflare/workers-types once restart options are published
export interface RestartFromStep {
  name: string;
  count?: number;
  type?: "do" | "sleep" | "waitForEvent";
}

export interface WorkflowInstanceRestartOptions {
  from?: RestartFromStep;
}

// this.env.WORKFLOW is WorkflowBinding
export class WorkflowBinding extends WorkerEntrypoint<Env> {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
  }

  public async create({
    id = crypto.randomUUID(),
    params = {},
  }: WorkflowInstanceCreateOptions = {}): Promise<{
    id: string;
  }> {
    if (!isValidWorkflowInstanceId(id)) {
      throw new WorkflowError("Workflow instance has invalid id");
    }

    const stubId = this.env.ENGINE.idFromName(id);
    const stub = this.env.ENGINE.get(stubId);
    const introspectionSession = workflowIntrospectionSessions.get(
      this.env.WORKFLOW_NAME,
    );

    if (introspectionSession !== undefined) {
      const modifier = stub.getInstanceModifier();
      introspectionSession.instanceIds.push(id);
      for (const operation of introspectionSession.operations) {
        await applyWorkflowIntrospectionOperation(modifier, operation);
      }
    }

    const now = new Date().toISOString();
    const initPromise = stub
      .init(
        0, // accountId: number,
        {} as DatabaseWorkflow, // workflow: DatabaseWorkflow,
        {} as DatabaseVersion, // version: DatabaseVersion,
        {
          id,
          created_on: now,
          modified_on: now,
          workflow_id: "",
          version_id: "",
          status: 0, // InstanceStatus.Queued
          started_on: now,
          ended_on: null,
        } satisfies DatabaseInstance,
        {
          timestamp: new Date(),
          payload: params as Readonly<typeof params>,
          instanceId: id,
          workflowName: this.env.WORKFLOW_NAME,
        },
      )
      .then((val) => {
        if (val !== undefined) {
          val[Symbol.dispose]();
        }
      })
      .catch(() => {
        // Suppress all rejections: create() should queue and
        // return immediately
      });

    this.ctx.waitUntil(initPromise);

    return {
      id,
    };
  }

  public async get(id: string): Promise<WorkflowInstance> {
    const stubId = this.env.ENGINE.idFromName(id);
    const stub = this.env.ENGINE.get(stubId);

    // Pass a getter function so WorkflowHandle can get a fresh stub after abort
    const getStub = () => this.env.ENGINE.get(this.env.ENGINE.idFromName(id));

    const handle = new WorkflowHandle(id, stub, getStub);

    try {
      await handle.status();
    } catch {
      throw new Error("instance.not_found");
    }

    return handle;
  }

  public async createBatch(
    batch: Array<WorkflowInstanceCreateOptions<unknown>>,
  ): Promise<Array<{ id: string }>> {
    if (batch.length === 0) {
      throw new Error(
        "WorkflowError: batchCreate should have at least 1 instance",
      );
    }

    return await Promise.all(
      batch.map(async (val) => {
        const res = await this.create(val);
        return res;
      }),
    );
  }

  public async deleteBatch(
    instanceIds: string[],
  ): Promise<WorkflowBatchDeleteResult> {
    if (instanceIds.length > 100) {
      throw new WorkflowError(
        "deleteBatch is limited to 100 instances at a time",
      );
    }
    const deleted: { id: string }[] = [];
    const errors: { id: string; code: number; message: string }[] = [];
    for (const id of new Set(instanceIds)) {
      try {
        const handle = (await this.get(id)) as WorkflowHandle;
        await handle.delete();
        deleted.push({ id });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({
          id,
          code: message.startsWith("instance.not_found") ? 404 : 400,
          message,
        });
      }
    }
    return { deleted, errors };
  }

  public async unsafeGetBindingName(): Promise<string> {
    // async because of rpc
    return this.env.BINDING_NAME;
  }

  public async unsafeStartIntrospection(): Promise<string> {
    if (workflowIntrospectionSessions.has(this.env.WORKFLOW_NAME)) {
      throw new Error(
        `Workflow ${JSON.stringify(this.env.WORKFLOW_NAME)} already has an active introspection session for binding ${JSON.stringify(this.env.BINDING_NAME)}.`,
      );
    }

    const sessionId = crypto.randomUUID();
    workflowIntrospectionSessions.set(this.env.WORKFLOW_NAME, {
      id: sessionId,
      operations: [],
      instanceIds: [],
    });
    return sessionId;
  }

  public async unsafeStopIntrospection(sessionId: string): Promise<void> {
    const session = workflowIntrospectionSessions.get(this.env.WORKFLOW_NAME);
    if (session?.id === sessionId) {
      workflowIntrospectionSessions.delete(this.env.WORKFLOW_NAME);
    }
  }

  public async unsafeSetIntrospectionOperations(
    sessionId: string,
    operations: Array<WorkflowIntrospectionOperation>,
  ): Promise<void> {
    const session = getWorkflowIntrospectionSession(
      this.env.WORKFLOW_NAME,
      sessionId,
    );
    session.operations = operations;
  }

  public async unsafeGetIntrospectionInstances(
    sessionId: string,
  ): Promise<Array<string>> {
    return getWorkflowIntrospectionSession(this.env.WORKFLOW_NAME, sessionId)
      .instanceIds;
  }

  public async unsafeGetInstanceModifier(instanceId: string): Promise<unknown> {
    // async because of rpc
    const stubId = this.env.ENGINE.idFromName(instanceId);
    const stub = this.env.ENGINE.get(stubId);

    const instanceModifier = stub.getInstanceModifier();

    return instanceModifier;
  }

  public async unsafeWaitForStepResult(
    instanceId: string,
    name: string,
    index?: number,
  ): Promise<unknown> {
    const stubId = this.env.ENGINE.idFromName(instanceId);
    const stub = this.env.ENGINE.get(stubId);

    return await stub.waitForStepResult(name, index);
  }

  public async unsafeAbort(instanceId: string, reason?: string): Promise<void> {
    const stubId = this.env.ENGINE.idFromName(instanceId);
    const stub = this.env.ENGINE.get(stubId);

    try {
      await stub.unsafeAbort(reason);
    } catch {
      // do nothing because we want to dispose this instance
    }
  }

  public async unsafeWaitForStatus(
    instanceId: string,
    status: string,
  ): Promise<void> {
    const stubId = this.env.ENGINE.idFromName(instanceId);
    const stub = this.env.ENGINE.get(stubId);
    return await stub.waitForStatus(status);
  }

  public async unsafeGetOutputOrError(
    instanceId: string,
    isOutput: boolean,
  ): Promise<unknown> {
    const stubId = this.env.ENGINE.idFromName(instanceId);
    const stub = this.env.ENGINE.get(stubId);
    return await stub.getOutputOrError(isOutput);
  }
}

export class WorkflowHandle extends RpcTarget implements WorkflowInstance {
  private stub: DurableObjectStub<Engine>;

  constructor(
    public id: string,
    stub: DurableObjectStub<Engine>,
    private getStub: () => DurableObjectStub<Engine>,
  ) {
    super();
    this.stub = stub;
  }

  public async pause(): Promise<void> {
    try {
      await this.stub.changeInstanceStatus("pause");
    } catch (e) {
      // pause causes instance abortion
      if (!isUserTriggeredPause(e)) {
        throw e;
      }
    }
  }

  public async resume(): Promise<void> {
    await this.stub.changeInstanceStatus("resume");
  }

  public async terminate(): Promise<void> {
    try {
      await this.stub.changeInstanceStatus("terminate");
    } catch (e) {
      // terminate causes instance abortion
      if (!isUserTriggeredTerminate(e)) {
        throw e;
      }
    }
  }

  public async restart(
    options?: WorkflowInstanceRestartOptions,
  ): Promise<void> {
    try {
      await this.stub.changeInstanceStatus("restart", options?.from);
    } catch (e) {
      // restart causes instance abortion
      if (!isUserTriggeredRestart(e)) {
        throw e;
      }
    }

    // trigger restart flow after abortion
    this.stub = this.getStub();
    await this.stub.attemptRestart();
  }

  public async status(): Promise<
    InstanceStatus & { __LOCAL_DEV_STEP_OUTPUTS: Array<unknown> }
  > {
    // Both getStatus() and readLogs() must use the same fresh stub.
    // After pause/restart/terminate aborts the DO, the stub goes stale
    const fetchStatusAndLogs = async () => {
      const status = await this.stub.getStatus();

      // NOTE(lduarte): for some reason, sync functions over RPC are typed as never instead of Promise<EngineLogs>
      const logs = await (this.stub.readLogs() as unknown as Promise<
        EngineLogs & Disposable
      >);

      return { status, logs };
    };

    let result: {
      status: EngineInstanceStatus;
      logs: EngineLogs & Disposable;
    };
    try {
      result = await fetchStatusAndLogs();
    } catch {
      this.stub = this.getStub();
      result = await fetchStatusAndLogs();
    }
    // Dispose the RPC handle when the method scope exits
    using logs = result.logs;

    const filteredLogs = logs.logs.filter(
      (log) =>
        log.event === InstanceEvent.STEP_SUCCESS ||
        log.event === InstanceEvent.WAIT_COMPLETE,
    );

    const stepOutputs = filteredLogs.map((log) =>
      log.event === InstanceEvent.STEP_SUCCESS
        ? log.metadata.result
        : log.metadata.payload,
    );

    const workflowOutput =
      logs.logs.find((log) => log.event === InstanceEvent.WORKFLOW_SUCCESS)
        ?.metadata.result ?? null;

    const workflowError = logs.logs.find(
      (log) => log.event === InstanceEvent.WORKFLOW_FAILURE,
    )?.metadata.error;

    return {
      status: instanceStatusName(result.status),
      __LOCAL_DEV_STEP_OUTPUTS: stepOutputs,
      output: workflowOutput,
      error: workflowError,
    };
  }

  public async sendEvent(args: {
    payload: unknown;
    type: string;
  }): Promise<void> {
    await this.stub.receiveEvent({
      payload: args.payload,
      type: args.type,
      timestamp: new Date(),
    });
  }

  public async delete(): Promise<void> {
    const { status } = await this.status();
    if (
      status !== "complete" &&
      status !== "errored" &&
      status !== "terminated"
    ) {
      throw new Error(
        "instance.not_terminal: only instances in a terminal state (complete, errored, terminated) can be deleted",
      );
    }
    try {
      // Wiping the engine DO's storage makes a subsequent `get(id)` report
      // instance.not_found — the local equivalent of deleting the record.
      await this.stub.unsafeAbort("instance.deleted");
    } catch {
      // unsafeAbort aborts the DO out from under its own RPC channel, which
      // may reject the call after the storage wipe already happened.
    }
  }
}
