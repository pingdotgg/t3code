// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { env } from "cloudflare:test";
import { setTestWorkflowCallback } from "./test-entry.ts";
import type {
  DatabaseInstance,
  DatabaseVersion,
  DatabaseWorkflow,
  Engine,
} from "../engine.ts";
import type { WorkflowStep } from "cloudflare:workers";

// Track fire-and-forget init() RPC promises so they can be settled
// in afterAll hooks before vitest tears down miniflare
const pendingInits: Array<Promise<unknown>> = [];

/**
 * Await all tracked init promises (with a timeout safety net).
 * Call this in afterAll() for every test file that uses runWorkflow().
 */
export async function settlePendingWorkflows(): Promise<void> {
  await Promise.allSettled(pendingInits);
  pendingInits.length = 0;
}

export async function runWorkflow(
  instanceId: string,
  callback: (event: unknown, step: WorkflowStep) => Promise<unknown>,
): Promise<DurableObjectStub<Engine>> {
  const engineId = env.ENGINE.idFromName(instanceId);
  const engineStub = env.ENGINE.get(engineId);

  setTestWorkflowCallback(callback);

  // Fire-and-forget: suppress all rejections to prevent unhandled
  // rejections inside workerd (which crash the HTTP server on Windows).
  // Abort errors (pause, terminate, restart) are expected; workflow
  // errors (NonRetryableError, step failures) are also expected for
  // tests that intentionally trigger them. Tests validate correctness
  // through separate log/status assertions, not through init()'s result.
  const initPromise = engineStub
    .init(
      12346,
      {} as DatabaseWorkflow,
      {} as DatabaseVersion,
      { id: instanceId } as DatabaseInstance,
      { payload: {}, timestamp: new Date(), instanceId, workflowName: "" },
    )
    .catch(() => {});

  pendingInits.push(initPromise);

  return engineStub;
}

export async function runWorkflowAndAwait(
  instanceId: string,
  callback: (event: unknown, step: WorkflowStep) => Promise<unknown>,
): Promise<DurableObjectStub<Engine>> {
  const engineId = env.ENGINE.idFromName(instanceId);
  const engineStub = env.ENGINE.get(engineId);

  setTestWorkflowCallback(callback);

  await engineStub
    .init(
      12346,
      {} as DatabaseWorkflow,
      {} as DatabaseVersion,
      { id: instanceId } as DatabaseInstance,
      { payload: {}, timestamp: new Date(), instanceId, workflowName: "" },
    )
    .catch(() => {});

  return engineStub;
}
