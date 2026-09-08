import type {
  WorkflowBinding,
  WorkflowInstanceRestartOptions,
} from "../../../internal/workflows-shared/binding.ts";
import type { WorkflowIntrospectionOperation } from "../../../internal/workflows-shared/types.ts";

class WorkflowImpl implements Workflow {
  constructor(private binding: WorkflowBinding) {}

  async get(id: string): Promise<WorkflowInstance> {
    const instanceHandle = new InstanceImpl(id, this.binding);
    // throws instance.not_found if instance doesn't exist
    // this is needed for backwards compat
    await instanceHandle.status();
    return instanceHandle;
  }

  async create(
    options?: WorkflowInstanceCreateOptions,
  ): Promise<WorkflowInstance> {
    using result = (await this.binding.create(options)) as WorkflowInstance &
      Disposable;

    return new InstanceImpl(result.id, this.binding);
  }

  async createBatch(
    options: Array<WorkflowInstanceCreateOptions>,
  ): Promise<Array<WorkflowInstance>> {
    const result = await this.binding.createBatch(options);
    return result.map((res) => {
      return new InstanceImpl(res.id, this.binding);
    });
  }

  async deleteBatch(instanceIds: string[]): Promise<WorkflowBatchDeleteResult> {
    return this.binding.deleteBatch(instanceIds);
  }

  async unsafeGetBindingName(): Promise<string> {
    return this.binding.unsafeGetBindingName();
  }

  async unsafeStartIntrospection(): Promise<string> {
    return this.binding.unsafeStartIntrospection();
  }

  async unsafeStopIntrospection(sessionId: string): Promise<void> {
    return this.binding.unsafeStopIntrospection(sessionId);
  }

  async unsafeSetIntrospectionOperations(
    sessionId: string,
    operations: Array<WorkflowIntrospectionOperation>,
  ): Promise<void> {
    return this.binding.unsafeSetIntrospectionOperations(sessionId, operations);
  }

  async unsafeGetIntrospectionInstances(
    sessionId: string,
  ): Promise<Array<string>> {
    return this.binding.unsafeGetIntrospectionInstances(sessionId);
  }

  async unsafeAbort(instanceId: string, reason?: string): Promise<void> {
    return this.binding.unsafeAbort(instanceId, reason);
  }

  async unsafeGetInstanceModifier(instanceId: string): Promise<unknown> {
    return this.binding.unsafeGetInstanceModifier(instanceId);
  }

  async unsafeWaitForStepResult(
    instanceId: string,
    name: string,
    index?: number,
  ): Promise<unknown> {
    return this.binding.unsafeWaitForStepResult(instanceId, name, index);
  }

  async unsafeWaitForStatus(instanceId: string, status: string): Promise<void> {
    return await this.binding.unsafeWaitForStatus(instanceId, status);
  }

  public async unsafeGetOutputOrError(
    instanceId: string,
    isOutput: boolean,
  ): Promise<unknown> {
    return this.binding.unsafeGetOutputOrError(instanceId, isOutput);
  }
}

class InstanceImpl implements WorkflowInstance {
  constructor(
    public id: string,
    private binding: WorkflowBinding,
  ) {}

  private async getInstance(): Promise<WorkflowInstance & Disposable> {
    return (await this.binding.get(this.id)) as WorkflowInstance & Disposable;
  }

  public async pause(): Promise<void> {
    using instance = await this.getInstance();
    await instance.pause();
  }

  public async resume(): Promise<void> {
    using instance = await this.getInstance();
    await instance.resume();
  }

  public async terminate(): Promise<void> {
    using instance = await this.getInstance();
    await instance.terminate();
  }

  public async restart(
    options?: WorkflowInstanceRestartOptions,
  ): Promise<void> {
    using instance = await this.getInstance();
    await instance.restart(options);
  }

  public async status(): Promise<InstanceStatus> {
    using instance = await this.getInstance();
    using res = (await instance.status()) as InstanceStatus & Disposable;
    return structuredClone(res);
  }

  public async sendEvent(args: {
    payload: unknown;
    type: string;
  }): Promise<void> {
    using instance = await this.getInstance();
    await instance.sendEvent(args);
  }

  public async delete(): Promise<void> {
    using instance = await this.getInstance();
    // Structural call: whether the ambient WorkflowInstance type in this
    // program carries `delete` depends on which workers-types copy wins
    // (vitest-pool-workers bundles an older one), but the runtime handle
    // (WorkflowHandle) always implements it.
    await (instance as unknown as { delete(): Promise<void> }).delete();
  }
}

export default function makeBinding(env: {
  binding: WorkflowBinding;
}): Workflow {
  return new WorkflowImpl(env.binding);
}
