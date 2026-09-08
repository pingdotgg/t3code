// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { InstanceEvent } from "../instance.ts";
import { WorkflowFatalError } from "./errors.ts";
import { isValidStepConfig } from "./validators.ts";
import type { WorkflowStepContext } from "../context.ts";
import type { Engine } from "../engine.ts";
import type { WorkflowStepConfig } from "cloudflare:workers";

type UserErrorField = {
  isUserError?: boolean;
};

// `:` can't appear in user-step cacheKeys (sha1-hex + `-` only).
export const ROLLBACK_CACHE_KEY_PREFIX = "rollback:";

export type RollbackContext = {
  ctx: WorkflowStepContext;
  error: Error;
  output: unknown;
  /** @deprecated Use `${ctx.step.name}-${ctx.step.count}` instead. */
  stepName: string;
};

// dup() to outlive the originating step.do call; Symbol.dispose locally
// (calling `.dispose()` would RPC to a non-existent remote method).
export type RollbackFn = ((ctx: RollbackContext) => Promise<void>) & {
  dup?: () => RollbackFn;
  [Symbol.dispose]?: () => void;
};

export type WorkflowStepRollbackConfig = Pick<WorkflowStepConfig, "retries" | "timeout">;

export type WorkflowStepRollbackOptions = {
  rollback: RollbackFn;
  rollbackConfig?: WorkflowStepRollbackConfig;
};

export type RollbackRegistryEntry = {
  fn: RollbackFn;
  stepContext: WorkflowStepContext;
  output?: unknown;
  config?: WorkflowStepConfig;
};

export type RollbackRegistration = RollbackRegistryEntry & {
  cacheKey: string;
};

export function parseRollbackOptions(
  stepName: string,
  options: unknown,
): WorkflowStepRollbackOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    const error = new WorkflowFatalError(
      `Rollback options for "${stepName}" must be an object`,
    ) as Error & UserErrorField;
    error.isUserError = true;
    throw error;
  }

  const rollbackOptions = options as Partial<WorkflowStepRollbackOptions>;
  if (typeof rollbackOptions.rollback !== "function") {
    const error = new WorkflowFatalError(`Rollback for "${stepName}" must be a function`) as Error &
      UserErrorField;
    error.isUserError = true;
    throw error;
  }

  if (
    rollbackOptions.rollbackConfig !== undefined &&
    !isValidStepConfig(rollbackOptions.rollbackConfig)
  ) {
    const error = new WorkflowFatalError(
      `Rollback config for "${stepName}" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/`,
    ) as Error & UserErrorField;
    error.isUserError = true;
    throw error;
  }

  return rollbackOptions as WorkflowStepRollbackOptions;
}

export function dupRollbackStub(fn: RollbackFn): RollbackFn {
  return fn.dup ? fn.dup() : fn;
}

export function disposeRollbackStub(fn: RollbackFn): void {
  try {
    fn[Symbol.dispose]?.();
  } catch (err) {
    console.warn("Failed to dispose rollback stub", err);
  }
}

export function registerRollbackFn(
  registry: Map<string, RollbackRegistryEntry>,
  registration: RollbackRegistration,
): void {
  const { cacheKey, fn, stepContext, output, config } = registration;
  const existing = registry.get(cacheKey);
  if (existing) {
    disposeRollbackStub(existing.fn);
  }
  registry.set(cacheKey, {
    fn: dupRollbackStub(fn),
    stepContext,
    ...("output" in registration && { output }),
    ...(config !== undefined && { config }),
  });
}

export function clearRollbackRegistry(registry: Map<string, RollbackRegistryEntry>): void {
  for (const entry of registry.values()) {
    disposeRollbackStub(entry.fn);
  }
  registry.clear();
}

function getRollbackRegistryEntriesInExecutionOrder(
  engine: Engine,
): Array<[string, RollbackRegistryEntry]> {
  const entries: Array<[string, RollbackRegistryEntry]> = [];
  const seen = new Set<string>();
  const stepStartGroupKeysDesc = engine.readStepStartGroupKeysDesc();
  const rollbackRegistryEntriesDesc = [...engine.rollbackRegistry.entries()].reverse();

  for (const cacheKey of stepStartGroupKeysDesc) {
    const entry = engine.rollbackRegistry.get(cacheKey);
    if (entry === undefined || seen.has(cacheKey)) {
      continue;
    }
    entries.push([cacheKey, entry]);
    seen.add(cacheKey);
  }

  for (const [cacheKey, entry] of rollbackRegistryEntriesDesc) {
    if (!seen.has(cacheKey)) {
      entries.push([cacheKey, entry]);
    }
  }

  return entries;
}

// LIFO; halts on first failure. Goes through Context.do so each rollback
// inherits retries/timeouts/attempt-logging.
export async function executeRollbacks(
  engine: Engine,
  triggerError: Error,
): Promise<{ ranAny: boolean; allSucceeded: boolean }> {
  if (engine.rollbackRegistry.size === 0) {
    return { ranAny: false, allSucceeded: true };
  }

  const entries = getRollbackRegistryEntriesInExecutionOrder(engine);
  engine.rollbackRegistry.clear();

  engine.writeLog(InstanceEvent.ROLLBACK_START, null, null, {
    triggerError: { name: triggerError.name, message: triggerError.message },
    totalSteps: entries.length,
  });

  let allSucceeded = true;
  let completed = 0;
  let stoppedAt = entries.length;

  for (const [i, [cacheKey, entry]] of entries.entries()) {
    const ctx = engine.createRollbackContext({ cacheKey });
    const rollbackName = `${entry.stepContext.step.name}-${entry.stepContext.step.count}`;
    try {
      await ctx.do(rollbackName, entry.config ?? {}, async () => {
        await entry.fn({
          ctx: structuredClone(entry.stepContext),
          error: triggerError,
          output: entry.output,
          stepName: rollbackName,
        });
      });
      completed++;
    } catch {
      // Context.do already wrote ROLLBACK_STEP_FAILURE; halt the chain.
      allSucceeded = false;
      stoppedAt = i + 1;
      break;
    } finally {
      disposeRollbackStub(entry.fn);
    }
  }

  const remainingEntries = entries.slice(stoppedAt);
  for (const [, entry] of remainingEntries) {
    disposeRollbackStub(entry.fn);
  }

  engine.writeLog(
    allSucceeded ? InstanceEvent.ROLLBACK_COMPLETE : InstanceEvent.ROLLBACK_FAILED,
    null,
    null,
    { totalSteps: entries.length, completedSteps: completed },
  );
  return { ranAny: completed > 0, allSucceeded };
}
