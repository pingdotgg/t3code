// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type {
  ModifierCallback,
  WorkflowBinding,
  WorkflowInstanceIntrospector,
  WorkflowInstanceModifier,
  WorkflowIntrospectionOperation,
  WorkflowIntrospectionStreamResult,
  WorkflowIntrospector,
  WorkflowStepSelector,
} from "./types.ts";

function normalizeStreamMockChunk(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new TypeError(
    "Workflow mockStepResult() ReadableStream chunks must be ArrayBuffer or TypedArray values.",
  );
}

async function readStreamMockChunks(
  stream: ReadableStream<unknown>,
): Promise<Array<Uint8Array>> {
  if (stream.locked) {
    throw new TypeError(
      "Workflow mockStepResult() received a locked or unreadable ReadableStream.",
    );
  }

  const chunks: Array<Uint8Array> = [];
  const reader = stream.getReader();
  let fullyRead = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        fullyRead = true;
        return chunks;
      }

      const chunk = normalizeStreamMockChunk(result.value);
      if (chunk.byteLength === 0) {
        continue;
      }

      chunks.push(chunk.slice());
    }
  } finally {
    if (!fullyRead) {
      await reader
        .cancel("stream mock consumption stopped before completion")
        .catch(() => {});
    }
    try {
      reader.releaseLock();
    } catch {
      /** Reader may still be processing cancel(). */
    }
  }
}

export class WorkflowInstanceModificationRecorder implements WorkflowInstanceModifier {
  constructor(
    private readonly operations: Array<WorkflowIntrospectionOperation>,
  ) {}

  async disableSleeps(steps?: Array<WorkflowStepSelector>): Promise<void> {
    this.operations.push({ type: "disableSleeps", steps });
  }

  async disableRetryDelays(steps?: Array<WorkflowStepSelector>): Promise<void> {
    this.operations.push({ type: "disableRetryDelays", steps });
  }

  async mockStepResult(
    step: WorkflowStepSelector,
    stepResult: unknown,
  ): Promise<void> {
    if (stepResult instanceof ReadableStream) {
      const streamResult: WorkflowIntrospectionStreamResult = {
        __workflowIntrospectionStreamResult: true,
        chunks: await readStreamMockChunks(stepResult),
      };
      this.operations.push({
        type: "mockStepResult",
        step,
        stepResult: streamResult,
      });
      return;
    }

    this.operations.push({ type: "mockStepResult", step, stepResult });
  }

  async mockStepError(
    step: WorkflowStepSelector,
    error: Error,
    times?: number,
  ): Promise<void> {
    this.operations.push({
      type: "mockStepError",
      step,
      error: { name: error.name, message: error.message },
      times,
    });
  }

  async forceStepTimeout(
    step: WorkflowStepSelector,
    times?: number,
  ): Promise<void> {
    this.operations.push({ type: "forceStepTimeout", step, times });
  }

  async mockEvent(event: { type: string; payload: unknown }): Promise<void> {
    this.operations.push({ type: "mockEvent", event });
  }

  async forceEventTimeout(step: WorkflowStepSelector): Promise<void> {
    this.operations.push({ type: "forceEventTimeout", step });
  }
}

export class WorkflowIntrospectorHandle implements WorkflowIntrospector {
  #disposed = false;
  #sessionId: string | undefined;
  #instanceIntrospectors = new Map<string, WorkflowInstanceIntrospector>();
  #operations: Array<WorkflowIntrospectionOperation> = [];

  constructor(private readonly workflow: WorkflowBinding) {}

  async start(): Promise<void> {
    this.#sessionId = await this.workflow.unsafeStartIntrospection();
  }

  private getSessionId(): string {
    if (this.#sessionId === undefined) {
      throw new Error("Workflow introspection has not started.");
    }
    return this.#sessionId;
  }

  async modifyAll(fn: ModifierCallback): Promise<void> {
    const sessionId = this.getSessionId();
    await fn(new WorkflowInstanceModificationRecorder(this.#operations));
    await this.workflow.unsafeSetIntrospectionOperations(
      sessionId,
      this.#operations,
    );
  }

  async get(): Promise<Array<WorkflowInstanceIntrospector>> {
    const sessionId = this.getSessionId();
    await this.syncInstanceIntrospectors(sessionId);

    return Array.from(this.#instanceIntrospectors.values());
  }

  private async syncInstanceIntrospectors(sessionId: string): Promise<void> {
    const instanceIds =
      await this.workflow.unsafeGetIntrospectionInstances(sessionId);

    for (const instanceId of instanceIds) {
      if (!this.#instanceIntrospectors.has(instanceId)) {
        this.#instanceIntrospectors.set(
          instanceId,
          new WorkflowInstanceIntrospectorHandle(this.workflow, instanceId),
        );
      }
    }
  }

  private async stopIntrospectionSession(sessionId: string): Promise<void> {
    try {
      await this.syncInstanceIntrospectors(sessionId);
    } finally {
      await this.workflow.unsafeStopIntrospection(sessionId);
    }
  }

  private async disposeInstanceIntrospectors(): Promise<void> {
    try {
      await Promise.all(
        Array.from(this.#instanceIntrospectors.values(), (introspector) =>
          introspector.dispose(),
        ),
      );
    } finally {
      this.#instanceIntrospectors.clear();
    }
  }

  /** Keep this bound; explicit resource management may call the disposer unbound. */
  dispose = async (): Promise<void> => {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const sessionId = this.#sessionId;

    try {
      if (sessionId !== undefined) {
        await this.stopIntrospectionSession(sessionId);
      }
    } finally {
      await this.disposeInstanceIntrospectors();
    }
  };

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

export class WorkflowInstanceIntrospectorHandle implements WorkflowInstanceIntrospector {
  #instanceModifier: WorkflowInstanceModifier | undefined;
  #instanceModifierPromise: Promise<WorkflowInstanceModifier> | undefined;

  constructor(
    private readonly workflow: WorkflowBinding,
    private readonly instanceId: string,
  ) {
    this.#instanceModifierPromise = workflow
      .unsafeGetInstanceModifier(instanceId)
      .then((modifier) => {
        this.#instanceModifier = modifier as WorkflowInstanceModifier;
        this.#instanceModifierPromise = undefined;
        return this.#instanceModifier;
      });

    // To avoid an unhandled rejection when the handle is used without modify()
    void this.#instanceModifierPromise.catch(() => {});
  }

  async modify(fn: ModifierCallback): Promise<WorkflowInstanceIntrospector> {
    if (this.#instanceModifierPromise !== undefined) {
      this.#instanceModifier = await this.#instanceModifierPromise;
    }
    if (this.#instanceModifier === undefined) {
      throw new Error(
        "could not apply modifications due to internal error. Retrying the test may resolve the issue.",
      );
    }

    await fn(this.#instanceModifier);

    return this;
  }

  async waitForStepResult(step: WorkflowStepSelector): Promise<unknown> {
    return await this.workflow.unsafeWaitForStepResult(
      this.instanceId,
      step.name,
      step.index,
    );
  }

  async waitForStatus(status: string): Promise<void> {
    if (status === "queued") {
      return;
    }

    await this.workflow.unsafeWaitForStatus(this.instanceId, status);
  }

  async getOutput(): Promise<unknown> {
    return await this.workflow.unsafeGetOutputOrError(this.instanceId, true);
  }

  async getError(): Promise<{ name: string; message: string }> {
    return (await this.workflow.unsafeGetOutputOrError(
      this.instanceId,
      false,
    )) as {
      name: string;
      message: string;
    };
  }

  /** Keep this bound; explicit resource management may call the disposer unbound. */
  dispose = async (): Promise<void> => {
    await this.workflow.unsafeAbort(this.instanceId, "Instance dispose");
  };

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}
