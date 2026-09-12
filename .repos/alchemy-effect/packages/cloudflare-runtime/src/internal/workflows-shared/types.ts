// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
export type WorkflowStepSelector = {
  name: string;
  index?: number;
};

export type WorkflowInstanceModifier = {
  disableSleeps(steps?: Array<WorkflowStepSelector>): Promise<void>;
  disableRetryDelays(steps?: Array<WorkflowStepSelector>): Promise<void>;
  mockStepResult(
    step: WorkflowStepSelector,
    stepResult: unknown,
  ): Promise<void>;
  mockStepError(
    step: WorkflowStepSelector,
    error: Error,
    times?: number,
  ): Promise<void>;
  forceStepTimeout(step: WorkflowStepSelector, times?: number): Promise<void>;
  mockEvent(event: { type: string; payload: unknown }): Promise<void>;
  forceEventTimeout(step: WorkflowStepSelector): Promise<void>;
};

export type WorkflowIntrospectionStreamResult = {
  __workflowIntrospectionStreamResult: true;
  chunks: Array<Uint8Array>;
};

export type WorkflowIntrospectionOperation =
  | { type: "disableSleeps"; steps?: Array<WorkflowStepSelector> }
  | { type: "disableRetryDelays"; steps?: Array<WorkflowStepSelector> }
  | {
      type: "mockStepResult";
      step: WorkflowStepSelector;
      stepResult: unknown;
    }
  | {
      type: "mockStepError";
      step: WorkflowStepSelector;
      error: { name: string; message: string };
      times?: number;
    }
  | { type: "forceStepTimeout"; step: WorkflowStepSelector; times?: number }
  | { type: "mockEvent"; event: { type: string; payload: unknown } }
  | { type: "forceEventTimeout"; step: WorkflowStepSelector };

export type WorkflowBinding = {
  unsafeGetInstanceModifier(
    instanceId: string,
  ): Promise<WorkflowInstanceModifier>;
  unsafeWaitForStepResult(
    instanceId: string,
    name: string,
    index?: number,
  ): Promise<unknown>;
  unsafeWaitForStatus(instanceId: string, status: string): Promise<void>;
  unsafeGetOutputOrError(
    instanceId: string,
    isOutput: boolean,
  ): Promise<unknown>;
  unsafeAbort(instanceId: string, reason?: string): Promise<void>;
  unsafeStartIntrospection(): Promise<string>;
  unsafeSetIntrospectionOperations(
    sessionId: string,
    operations: Array<WorkflowIntrospectionOperation>,
  ): Promise<void>;
  unsafeStopIntrospection(sessionId: string): Promise<void>;
  unsafeGetIntrospectionInstances(sessionId: string): Promise<Array<string>>;
};

export type ModifierCallback = (
  modifier: WorkflowInstanceModifier,
) => Promise<void>;

export interface WorkflowInstanceIntrospector {
  modify(fn: ModifierCallback): Promise<WorkflowInstanceIntrospector>;
  waitForStepResult(step: WorkflowStepSelector): Promise<unknown>;
  waitForStatus(status: string): Promise<void>;
  getOutput(): Promise<unknown>;
  getError(): Promise<{ name: string; message: string }>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface WorkflowIntrospector {
  modifyAll(fn: ModifierCallback): Promise<void>;
  get(): Promise<Array<WorkflowInstanceIntrospector>>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
