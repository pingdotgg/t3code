// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { RpcTarget } from "cloudflare:workers";
import { ms } from "itty-time";
import {
  INSTANCE_METADATA,
  InstanceEvent,
  InstanceStatus,
} from "./instance.ts";
import { computeHash } from "./lib/cache.ts";
import {
  ABORT_REASONS,
  InvalidStepReadableStreamError,
  OversizedStreamChunkError,
  PreservedNonRetryableError,
  shouldPreserveNonRetryableError,
  StreamOutputStorageLimitError,
  UnsupportedStreamChunkError,
  WorkflowFatalError,
  WorkflowInternalError,
  WorkflowTimeoutError,
} from "./lib/errors.ts";
import { calcRetryDuration } from "./lib/retries.ts";
import {
  parseRollbackOptions,
  registerRollbackFn,
  ROLLBACK_CACHE_KEY_PREFIX,
} from "./lib/rollback.ts";
import {
  cleanupPendingStreamOutput,
  createReplayReadableStream,
  getInvalidStoredStreamOutputError,
  getStreamOutputMetaKey,
  isReadableStreamLike,
  rollbackStreamOutput,
  StreamOutputState,
  writeStreamOutput,
} from "./lib/streams.ts";
import {
  isValidStepConfig,
  isValidStepName,
  MAX_STEP_NAME_LENGTH,
} from "./lib/validators.ts";
import { MODIFIER_KEYS } from "./modifier.ts";
import type { Engine } from "./engine.ts";
import type { InstanceMetadata } from "./instance.ts";
import type {
  RollbackFn,
  WorkflowStepRollbackOptions,
} from "./lib/rollback.ts";
import type { StreamOutputMeta } from "./lib/streams.ts";
import type {
  WorkflowSleepDuration,
  WorkflowStepConfig,
  WorkflowStepEvent,
} from "cloudflare:workers";

export type Event = {
  timestamp: Date;
  payload: unknown;
  type: string;
};

export type ResolvedStepConfig = Required<
  Pick<WorkflowStepConfig, "retries" | "timeout">
> &
  Pick<WorkflowStepConfig, "sensitive">;

const defaultConfig: ResolvedStepConfig = {
  retries: {
    limit: 5,
    delay: 1000,
    backoff: "exponential",
  },
  timeout: "10 minutes",
};

/**
 * Returns a copy of `value` that is safe to persist via Durable Object SQL
 * storage without dragging unrelated bytes along with typed-array views.
 *
 * Background: workerd's `v8::ValueSerializer` writes the entire backing
 * `ArrayBuffer` for typed-array views, not just `byteLength` bytes. A view
 * sliced from a much larger buffer (`crypto.getRandomValues`, `arr.slice(...)`,
 * fetch-stream copies) blows up the wire size by a factor of
 * (backing-size / view-size) and can hit `SQLITE_TOOBIG` at view sizes well
 * below the documented 1MiB step-output limit (see issue #14101). Copying the
 * view's bytes into a tight backing buffer before persistence brings local
 * `wrangler dev` behaviour in line with production.
 *
 * The walk is recursive (cycle-safe via a `WeakMap`) so views nested inside
 * objects, arrays, Maps, and Sets are also compacted. View types are preserved
 * (`Uint8Array` stays `Uint8Array`, `Int16Array` stays `Int16Array`, etc.) so
 * the persisted shape matches the live shape — cached replays observe the
 * same constructor type the step originally returned. Class instances and
 * host objects (`Date`, `RegExp`, raw `ArrayBuffer`, streams, `Blob`, …) are
 * passed through unchanged — recursing into them would either fail to
 * reconstruct the original type or trigger their own structured-clone path.
 */
function normalizeForStorage(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  // Primitives: nothing to do.
  if (value === null || typeof value !== "object") {
    return value;
  }

  // Already visited (cycle): return the previously-built copy so the result
  // graph mirrors the original's cycle topology.
  if (seen.has(value)) {
    return seen.get(value);
  }

  // Typed-array views (TypedArray + DataView): copy bytes into a tight
  // backing buffer, preserving the original view constructor.
  if (ArrayBuffer.isView(value)) {
    return buildCompactView(value);
  }

  if (Array.isArray(value)) {
    const result: Array<unknown> = [];
    seen.set(value, result);
    for (const item of value) {
      result.push(normalizeForStorage(item, seen));
    }
    return result;
  }

  if (value instanceof Map) {
    const result = new Map();
    seen.set(value, result);
    for (const [k, v] of value) {
      result.set(normalizeForStorage(k, seen), normalizeForStorage(v, seen));
    }
    return result;
  }

  if (value instanceof Set) {
    const result = new Set();
    seen.set(value, result);
    for (const v of value) {
      result.add(normalizeForStorage(v, seen));
    }
    return result;
  }

  // Plain objects (Object literals and null-prototype objects). Class
  // instances and host objects fall through to the pass-through below.
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const key of Object.keys(value)) {
      result[key] = normalizeForStorage(
        (value as Record<string, unknown>)[key],
        seen,
      );
    }
    return result;
  }

  return value;
}

type ViewCtor = new (buffer: ArrayBufferLike) => ArrayBufferView;
function buildCompactView(view: ArrayBufferView): ArrayBufferView {
  const tightBuffer = view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  );
  return new (view.constructor as ViewCtor)(tightBuffer);
}

export interface UserErrorField {
  isUserError?: boolean;
}

export type StepState = {
  attemptedCount: number;
};

export type WorkflowStepContext = {
  step: {
    name: string;
    count: number;
  };
  attempt: number;
  config: ResolvedStepConfig;
};

const PAUSE_DATETIME = "PAUSE_DATETIME";

export class Context extends RpcTarget {
  #engine: Engine;
  #state: DurableObjectState;

  #counters: Map<string, number> = new Map();
  #lifetimeStepCounter: number = 0;

  #rollbackStep: { cacheKey: string } | undefined;

  constructor(
    engine: Engine,
    state: DurableObjectState,
    rollbackStep?: { cacheKey: string },
  ) {
    super();
    this.#engine = engine;
    this.#state = state;
    this.#rollbackStep = rollbackStep;
  }

  async #checkForPendingPause(): Promise<void> {
    if (this.#engine.timeoutHandler.isRunningStep()) {
      return;
    }

    const status = await this.#engine.getStatus();

    if (status === InstanceStatus.Paused) {
      throw new Error(ABORT_REASONS.USER_PAUSE);
    }

    if (status === InstanceStatus.WaitingForPause) {
      await this.#state.storage.put(PAUSE_DATETIME, new Date());
      const metadata =
        await this.#state.storage.get<InstanceMetadata>(INSTANCE_METADATA);
      if (metadata) {
        await this.#engine.setStatus(
          metadata.accountId,
          metadata.instance.id,
          InstanceStatus.Paused,
        );
      }
      throw new Error(ABORT_REASONS.USER_PAUSE);
    }
  }

  #getCount(name: string): number {
    let val = this.#counters.get(name) ?? 0;
    // 1-indexed, as we're increasing the value before write
    val++;
    this.#counters.set(name, val);

    return val;
  }

  #registerRollback(options: {
    cacheKey: string;
    rollbackFn: RollbackFn | undefined;
    stepContext: WorkflowStepContext;
    output?: unknown;
    rollbackConfig?: WorkflowStepConfig;
  }): void {
    const { cacheKey, rollbackFn, stepContext, output, rollbackConfig } =
      options;
    if (rollbackFn && this.#rollbackStep === undefined) {
      registerRollbackFn(this.#engine.rollbackRegistry, {
        cacheKey,
        fn: rollbackFn,
        stepContext,
        ...("output" in options && { output }),
        ...(rollbackConfig !== undefined && { config: rollbackConfig }),
      });
    }
  }

  do(
    name: string,
    callback: (ctx: WorkflowStepContext) => Promise<unknown>,
    rollbackOptions?: WorkflowStepRollbackOptions,
  ): Promise<unknown>;
  do(
    name: string,
    config: WorkflowStepConfig,
    callback: (ctx: WorkflowStepContext) => Promise<unknown>,
    rollbackOptions?: WorkflowStepRollbackOptions,
  ): Promise<unknown>;

  async do<T>(
    name: string,
    ...rest: Array<unknown>
  ): Promise<unknown | void | undefined> {
    let closure: (ctx: WorkflowStepContext) => Promise<T>;
    let stepConfig: WorkflowStepConfig;
    let rollbackOptions: WorkflowStepRollbackOptions | undefined;

    const first = rest[0];
    if (typeof first === "function") {
      closure = first as (ctx: WorkflowStepContext) => Promise<T>;
      stepConfig = {};
      rollbackOptions = parseRollbackOptions(name, rest[1]);
    } else {
      stepConfig = (first ?? {}) as WorkflowStepConfig;
      closure = rest[1] as (ctx: WorkflowStepContext) => Promise<T>;
      if (typeof closure !== "function") {
        const error = new WorkflowFatalError(
          `Step "${name}" requires a callback function`,
        ) as Error & UserErrorField;
        error.isUserError = true;
        throw error;
      }
      rollbackOptions = parseRollbackOptions(name, rest[2]);
    }
    const { rollback: rollbackFn, rollbackConfig } = rollbackOptions ?? {};

    const isRollback = this.#rollbackStep !== undefined;
    const events = isRollback
      ? {
          start: InstanceEvent.ROLLBACK_STEP_START,
          attemptStart: InstanceEvent.ROLLBACK_ATTEMPT_START,
          attemptSuccess: InstanceEvent.ROLLBACK_ATTEMPT_SUCCESS,
          attemptFailure: InstanceEvent.ROLLBACK_ATTEMPT_FAILURE,
          success: InstanceEvent.ROLLBACK_STEP_SUCCESS,
          failure: InstanceEvent.ROLLBACK_STEP_FAILURE,
        }
      : {
          start: InstanceEvent.STEP_START,
          attemptStart: InstanceEvent.ATTEMPT_START,
          attemptSuccess: InstanceEvent.ATTEMPT_SUCCESS,
          attemptFailure: InstanceEvent.ATTEMPT_FAILURE,
          success: InstanceEvent.STEP_SUCCESS,
          failure: InstanceEvent.STEP_FAILURE,
        };

    if (!isRollback) {
      this.#lifetimeStepCounter++;

      const stepLimit = this.#engine.stepLimit;
      if (this.#lifetimeStepCounter > stepLimit) {
        throw new WorkflowFatalError(
          `The limit of ${stepLimit} steps has been reached. This limit can be changed in your worker configuration.`,
        );
      }
    }

    if (!isValidStepName(name)) {
      // NOTE(lduarte): marking errors as user error allows the observability layer to avoid leaking
      // user errors to sentry while making everything more observable. `isUserError` is not serialized
      // into userland code due to how workerd serialzises errors over RPC - we also set it as undefined
      // in the obs layer in case changes to workerd happen
      const error = new WorkflowFatalError(
        `Step name "${name}" exceeds max length (${MAX_STEP_NAME_LENGTH} chars) or invalid characters found`,
      ) as Error & UserErrorField;
      error.isUserError = true;
      throw error;
    }

    if (!isValidStepConfig(stepConfig)) {
      const error = new WorkflowFatalError(
        `Step config for "${name}" is in a invalid format. See https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/`,
      ) as Error & UserErrorField;
      error.isUserError = true;
      throw error;
    }

    let config: ResolvedStepConfig = {
      ...defaultConfig,
      ...stepConfig,
      retries: {
        ...defaultConfig.retries,
        ...stepConfig.retries,
      },
    };

    let cacheKey: string;
    let count: number;
    let stepNameWithCounter: string;
    const rollbackStep = this.#rollbackStep;
    if (rollbackStep !== undefined) {
      cacheKey = `${ROLLBACK_CACHE_KEY_PREFIX}${rollbackStep.cacheKey}`;
      count = 1;
      stepNameWithCounter = name;
    } else {
      const hash = await computeHash(name);
      count = this.#getCount("run-" + name);
      cacheKey = `${hash}-${count}`;
      stepNameWithCounter = `${name}-${count}`;
    }

    const valueKey = `${cacheKey}-value`;
    const streamMetaKey = getStreamOutputMetaKey(cacheKey);
    const configKey = `${cacheKey}-config`;
    const errorKey = `${cacheKey}-error`;
    const stepStateKey = `${cacheKey}-metadata`;
    const retryDelayDisableKey = `${MODIFIER_KEYS.DISABLE_RETRY_DELAY}${valueKey}`;

    const maybeMap = await this.#state.storage.get([
      valueKey,
      streamMetaKey,
      configKey,
      errorKey,
      stepStateKey,
    ]);

    // Check cache -- streams first, then plain values
    const maybeStreamMeta = maybeMap.get(streamMetaKey) as
      | StreamOutputMeta
      | undefined
      | null;
    const cachedConfig = maybeMap.get(configKey) as
      | ResolvedStepConfig
      | undefined;
    if (maybeStreamMeta?.state === StreamOutputState.Complete) {
      const cachedState = maybeMap.get(stepStateKey) as StepState | undefined;
      const maybeOutputError = getInvalidStoredStreamOutputError(
        this.#state.storage,
        cacheKey,
        maybeStreamMeta,
      );
      if (maybeOutputError !== undefined) {
        throw new WorkflowInternalError(
          `Stored output for ${stepNameWithCounter} is corrupt or incomplete.`,
        );
      }

      const result = createReplayReadableStream({
        storage: this.#state.storage,
        cacheKey,
        meta: maybeStreamMeta,
      }) as T;
      this.#registerRollback({
        cacheKey,
        rollbackFn,
        stepContext: {
          step: { name, count },
          attempt: cachedState?.attemptedCount ?? 1,
          config: cachedConfig ?? config,
        },
        output: result,
        rollbackConfig,
      });
      return result;
    } else if (maybeStreamMeta !== undefined && maybeStreamMeta !== null) {
      // We're not in a complete state - means we crashed while persisting a stream on a previous invocation - need to cleanup
      await cleanupPendingStreamOutput(this.#state.storage, cacheKey).catch(
        () => {},
      );
    }

    const maybeResult = maybeMap.get(valueKey);

    if (maybeResult) {
      const cachedState = maybeMap.get(stepStateKey) as StepState | undefined;
      const result = (maybeResult as { value: T }).value;
      this.#registerRollback({
        cacheKey,
        rollbackFn,
        stepContext: {
          step: { name, count },
          attempt: cachedState?.attemptedCount ?? 1,
          config: cachedConfig ?? config,
        },
        output: result,
        rollbackConfig,
      });
      return result;
    }

    const maybeError: (Error & UserErrorField) | undefined = maybeMap.get(
      errorKey,
    ) as Error | undefined;

    if (maybeError) {
      maybeError.isUserError = true;
      throw maybeError;
    }

    // Persist initial config because user can pass in dynamic config
    if (cachedConfig === undefined) {
      await this.#state.storage.put(configKey, config);
    } else {
      config = cachedConfig;
    }

    const attemptLogs = this.#engine
      .readLogsFromStep(cacheKey)
      .filter((val) =>
        [
          events.attemptSuccess,
          events.attemptFailure,
          events.attemptStart,
        ].includes(val.event),
      );

    // this means that the the engine died while executing this step - we can mark the latest attempt as failed
    if (
      attemptLogs.length > 0 &&
      attemptLogs.at(-1)?.event === events.attemptStart
    ) {
      // TODO: We should get this from SQL
      const stepState = ((await this.#state.storage.get(
        stepStateKey,
      )) as StepState) ?? {
        attemptedCount: 1,
      };

      const priorityQueueHash = `${cacheKey}-${stepState.attemptedCount}`;

      // @ts-expect-error priorityQueue is initiated in init
      const timeoutEntryPQ = this.#engine.priorityQueue.getFirst(
        (a) => a.hash === priorityQueueHash && a.type === "timeout",
      );
      // if there's a timeout on the PQ we pop it, because we wont need it
      if (timeoutEntryPQ !== undefined) {
        // @ts-expect-error priorityQueue is initiated in init
        this.#engine.priorityQueue.remove(timeoutEntryPQ);
      }
      this.#engine.writeLog(
        events.attemptFailure,
        cacheKey,
        stepNameWithCounter,
        {
          attempt: stepState.attemptedCount,
          error: {
            name: "WorkflowInternalError",
            message: `Attempt failed due to internal workflows error`,
          },
        },
      );

      await this.#state.storage.put(stepStateKey, stepState);
    }

    const doWrapper = async (
      doWrapperClosure: (ctx: WorkflowStepContext) => Promise<unknown>,
    ): Promise<unknown | void | undefined> => {
      const stepState = ((await this.#state.storage.get(
        stepStateKey,
      )) as StepState) ?? {
        attemptedCount: 0,
      };
      const forwardStepContext = (): WorkflowStepContext => ({
        step: { name, count },
        attempt: stepState.attemptedCount,
        config,
      });

      // NOTE(caio): this might be a stream returning step - if so cleanup stale data from previous lifetimes
      await cleanupPendingStreamOutput(this.#state.storage, cacheKey).catch(
        () => {},
      );

      await this.#engine.timeoutHandler.acquire(this.#engine);

      if (stepState.attemptedCount == 0) {
        this.#engine.writeLog(events.start, cacheKey, stepNameWithCounter, {
          config,
        });
      } else {
        // in case the engine dies while retrying and wakes up before the retry period
        const priorityQueueHash = `${cacheKey}-${stepState.attemptedCount}`;
        // @ts-expect-error priorityQueue is initiated in init
        const retryEntryPQ = this.#engine.priorityQueue.getFirst(
          (a) => a.hash === priorityQueueHash && a.type === "retry",
        );
        // complete sleep if it didn't finish for some reason
        if (retryEntryPQ !== undefined) {
          const disableAllRetryDelays = await this.#state.storage.get(
            MODIFIER_KEYS.DISABLE_ALL_RETRY_DELAYS,
          );
          const disableThisRetryDelay =
            await this.#state.storage.get(retryDelayDisableKey);
          const disableRetryDelay =
            disableAllRetryDelays || disableThisRetryDelay;

          await this.#engine.timeoutHandler.release(this.#engine);
          await scheduler.wait(
            disableRetryDelay ? 0 : retryEntryPQ.targetTimestamp - Date.now(),
          );
          await this.#engine.timeoutHandler.acquire(this.#engine);
          // @ts-expect-error priorityQueue is initiated in init
          this.#engine.priorityQueue.remove({
            hash: priorityQueueHash,
            type: "retry",
          });
        }
      }

      let result;

      const instanceMetadata =
        await this.#state.storage.get<InstanceMetadata>(INSTANCE_METADATA);
      if (!instanceMetadata) {
        throw new Error("instanceMetadata is undefined");
      }
      const { accountId, instance } = instanceMetadata;

      let streamResultSeen = false;
      let lastStreamMeta: StreamOutputMeta | undefined;
      const abortController = new AbortController();
      const stepExecutionSignal = AbortSignal.any([
        abortController.signal,
        this.#engine.engineAbortController.signal,
      ]);

      try {
        const timeoutPromise = async (): Promise<never> => {
          const priorityQueueHash = `${cacheKey}-${stepState.attemptedCount}`;
          let timeout = ms(config.timeout);
          if (forceStepTimeout) {
            timeout = 0;
          }
          // @ts-expect-error priorityQueue is initiated in init
          await this.#engine.priorityQueue.add({
            hash: priorityQueueHash,
            targetTimestamp: Date.now() + timeout,
            type: "timeout",
          });
          await scheduler.wait(timeout);
          // if we reach here, means that we can try to delete the timeout from the PQ
          // because we managed to wait in the same lifetime
          // @ts-expect-error priorityQueue is initiated in init
          await this.#engine.priorityQueue.remove({
            hash: priorityQueueHash,
            type: "timeout",
          });
          const error = new WorkflowTimeoutError(
            `Execution timed out after ${timeout}ms`,
          );
          abortController.abort(error);
          throw error;
        };

        this.#engine.writeLog(
          events.attemptStart,
          cacheKey,
          stepNameWithCounter,
          {
            attempt: stepState.attemptedCount + 1,
          },
        );
        stepState.attemptedCount++;
        await this.#state.storage.put(stepStateKey, stepState);
        const priorityQueueHash = `${cacheKey}-${stepState.attemptedCount}`;

        const mockErrorKey = `${MODIFIER_KEYS.MOCK_STEP_ERROR}${valueKey}`;
        const persistentMockError = await this.#state.storage.get<{
          name: string;
          message: string;
        }>(mockErrorKey);
        const transientMockError = await this.#state.storage.get<{
          name: string;
          message: string;
        }>(`${mockErrorKey}-${stepState.attemptedCount}`);
        const mockErrorPayload = persistentMockError || transientMockError;

        // if a mocked error exists, throw it immediately
        if (mockErrorPayload) {
          const errorToThrow = new Error(mockErrorPayload.message);
          errorToThrow.name = mockErrorPayload.name;
          throw errorToThrow;
        }

        const replaceResult = await this.#state.storage.get(
          `${MODIFIER_KEYS.REPLACE_RESULT}${valueKey}`,
        );

        const forceStepTimeoutKey = `${MODIFIER_KEYS.FORCE_STEP_TIMEOUT}${valueKey}`;
        const persistentStepTimeout =
          await this.#state.storage.get(forceStepTimeoutKey);
        const transientStepTimeout = await this.#state.storage.get(
          `${forceStepTimeoutKey}-${stepState.attemptedCount}`,
        );
        const forceStepTimeout = persistentStepTimeout || transientStepTimeout;

        let timeoutTask: Promise<never> | undefined;

        const persistStepResult = async (
          value: unknown,
          activeTimeoutTask?: Promise<never>,
        ): Promise<unknown> => {
          if (!isReadableStreamLike(value)) {
            // Typed-array views anywhere in the value tree are copied
            // into a tight backing buffer so the full backing buffer
            // does not ride along with each view (issue #14101). View
            // types are preserved so cached replays observe the same
            // constructor as the live execution path. The caller still
            // receives the original `value` below — only the stored
            // shape changes.
            const stored = normalizeForStorage(value);
            await this.#state.storage.put(valueKey, { value: stored });
            abortController.abort("step finished");
            // @ts-expect-error priorityQueue is initiated in init
            this.#engine.priorityQueue.remove({
              hash: priorityQueueHash,
              type: "timeout",
            });
            return value;
          }

          streamResultSeen = true;
          const streamMeta = await writeStreamOutput({
            storage: this.#state.storage,
            cacheKey,
            attempt: stepState.attemptedCount,
            stream: value as ReadableStream<unknown>,
            signal: stepExecutionSignal,
            timeoutTask: activeTimeoutTask,
          });
          lastStreamMeta = streamMeta;

          abortController.abort("step finished");
          // @ts-expect-error priorityQueue is initiated in init
          this.#engine.priorityQueue.remove({
            hash: priorityQueueHash,
            type: "timeout",
          });
          return createReplayReadableStream({
            storage: this.#state.storage,
            cacheKey,
            meta: streamMeta,
          });
        };

        if (forceStepTimeout) {
          result = await timeoutPromise();
        } else if (replaceResult) {
          // Check if the mocked result is a stream sentinel (from mockStepResult with ReadableStream)
          if (
            replaceResult &&
            typeof replaceResult === "object" &&
            (replaceResult as Record<string, unknown>).__mockStreamOutput
          ) {
            const sentinel = replaceResult as {
              __mockStreamOutput: true;
              cacheKey: string;
              meta: StreamOutputMeta;
            };
            result = createReplayReadableStream({
              storage: this.#state.storage,
              cacheKey: sentinel.cacheKey,
              meta: sentinel.meta,
            });
          } else {
            result = replaceResult;
          }
        } else {
          timeoutTask = timeoutPromise();
          result = await Promise.race([
            doWrapperClosure({
              step: { name, count },
              attempt: stepState.attemptedCount,
              config: structuredClone(config),
            }),
            timeoutTask,
          ]);
        }

        // We store the value of `output` in an object with a `value` property. This allows us to store `undefined`,
        // in the case that it's returned from the user's code. This is because DO storage will error if you try to
        // store undefined directly.
        try {
          result = await persistStepResult(result, timeoutTask);
        } catch (e) {
          abortController.abort("step errored");
          // @ts-expect-error priorityQueue is initiated in init
          this.#engine.priorityQueue.remove({
            hash: priorityQueueHash,
            type: "timeout",
          });

          if (e instanceof WorkflowTimeoutError) {
            throw e;
          }

          // Fatal serialization/storage errors abort the DO immediately, so
          // previously registered rollbacks do not run for these paths.
          // This matches the existing terminal behavior for unrecoverable output.
          // Stream-specific fatal errors
          if (
            e instanceof InvalidStepReadableStreamError ||
            e instanceof OversizedStreamChunkError ||
            e instanceof UnsupportedStreamChunkError
          ) {
            this.#engine.writeLog(
              events.attemptFailure,
              cacheKey,
              stepNameWithCounter,
              {
                attempt: stepState.attemptedCount,
                error: new WorkflowFatalError(e.message),
              },
            );
            this.#engine.writeLog(
              events.failure,
              cacheKey,
              stepNameWithCounter,
              {},
            );
            this.#engine.writeLog(InstanceEvent.WORKFLOW_FAILURE, null, null, {
              error: new WorkflowFatalError(
                `The execution of the Workflow instance was terminated, as the step "${name}" returned an invalid ReadableStream output. ${e.message}`,
              ),
            });

            await this.#engine.setStatus(
              accountId,
              instance.id,
              InstanceStatus.Errored,
            );
            await this.#engine.timeoutHandler.release(this.#engine);
            await this.#engine.abort(ABORT_REASONS.NOT_SERIALISABLE);
            return;
          }

          if (e instanceof StreamOutputStorageLimitError) {
            this.#engine.writeLog(
              events.attemptFailure,
              cacheKey,
              stepNameWithCounter,
              {
                attempt: stepState.attemptedCount,
                error: new WorkflowFatalError(e.message),
              },
            );
            this.#engine.writeLog(
              events.failure,
              cacheKey,
              stepNameWithCounter,
              {},
            );
            this.#engine.writeLog(InstanceEvent.WORKFLOW_FAILURE, null, null, {
              error: new WorkflowFatalError(
                "The instance has exceeded the 1GiB storage limit",
              ),
            });

            await this.#engine.setStatus(
              accountId,
              instance.id,
              InstanceStatus.Errored,
            );
            await this.#engine.timeoutHandler.release(this.#engine);
            await this.#engine.abort(ABORT_REASONS.STORAGE_LIMIT_EXCEEDED);
            return;
          }

          // something that cannot be written to storage
          if (e instanceof Error && e.name === "DataCloneError") {
            this.#engine.writeLog(
              events.attemptFailure,
              cacheKey,
              stepNameWithCounter,
              {
                attempt: stepState.attemptedCount,
                error: new WorkflowFatalError(
                  `Value returned from step "${name}" is not serialisable`,
                ),
              },
            );
            this.#engine.writeLog(
              events.failure,
              cacheKey,
              stepNameWithCounter,
              {},
            );
            this.#engine.writeLog(InstanceEvent.WORKFLOW_FAILURE, null, null, {
              error: new WorkflowFatalError(
                `The execution of the Workflow instance was terminated, as the step "${name}" returned a value which is not serialisable`,
              ),
            });

            await this.#engine.setStatus(
              accountId,
              instance.id,
              InstanceStatus.Errored,
            );
            await this.#engine.timeoutHandler.release(this.#engine);
            await this.#engine.abort(ABORT_REASONS.NOT_SERIALISABLE);
          } else if (
            e instanceof Error &&
            e.message.includes("string or blob too big: SQLITE_TOOBIG")
          ) {
            throw new WorkflowInternalError(
              `Step ${stepNameWithCounter} output is too large. Maximum allowed size is 1MiB.`,
            );
          } else {
            // TODO (WOR-77): Send this to Sentry
            throw new WorkflowInternalError(
              `Storage failure for ${stepNameWithCounter} due to internal error.`,
            );
          }
          return;
        }

        // if we reach here, means that the closure ran successfully and we can remove the timeout from the PQ
        // @ts-expect-error priorityQueue is initiated in init
        this.#engine.priorityQueue.remove({
          hash: priorityQueueHash,
          type: "timeout",
        });

        this.#engine.writeLog(
          events.attemptSuccess,
          cacheKey,
          stepNameWithCounter,
          {
            attempt: stepState.attemptedCount,
          },
        );
      } catch (e) {
        const error = e as Error;
        // if we reach here, means that the closure ran but errored out and we can remove the timeout from the PQ
        // @ts-expect-error priorityQueue is initiated in init
        this.#engine.priorityQueue.remove({
          hash: `${cacheKey}-${stepState.attemptedCount}`,
          type: "timeout",
        });

        // Clean up any partial stream output from this failed attempt
        if (streamResultSeen) {
          try {
            await rollbackStreamOutput(
              this.#state.storage,
              cacheKey,
              stepState.attemptedCount,
            );
          } catch {
            // Best-effort cleanup
          }
        }

        if (
          e instanceof Error &&
          (error.name === "NonRetryableError" ||
            error.message.startsWith("NonRetryableError"))
        ) {
          const attemptError = shouldPreserveNonRetryableError()
            ? new PreservedNonRetryableError(e)
            : new WorkflowFatalError(
                `Step threw a NonRetryableError with message "${e.message}"`,
              );

          this.#engine.writeLog(
            events.attemptFailure,
            cacheKey,
            stepNameWithCounter,
            {
              attempt: stepState.attemptedCount,
              error: attemptError,
            },
          );
          this.#engine.writeLog(
            events.failure,
            cacheKey,
            stepNameWithCounter,
            {},
          );
          this.#registerRollback({
            cacheKey,
            rollbackFn,
            stepContext: forwardStepContext(),
            rollbackConfig,
          });

          throw error;
        }

        this.#engine.writeLog(
          events.attemptFailure,
          cacheKey,
          stepNameWithCounter,
          {
            attempt: stepState.attemptedCount,
            error: {
              name: error.name,
              message: error.message,
              // TODO (WOR-79): Stacks are all incorrect over RPC and need work
              // stack: error.stack,
            },
          },
        );

        await this.#state.storage.put(stepStateKey, stepState);

        if (stepState.attemptedCount <= config.retries.limit) {
          // TODO (WOR-71): Think through if every Error should transition
          const durationMs = calcRetryDuration(config, stepState);
          const disableAllRetryDelays = await this.#state.storage.get(
            MODIFIER_KEYS.DISABLE_ALL_RETRY_DELAYS,
          );
          const disableThisRetryDelay =
            await this.#state.storage.get(retryDelayDisableKey);
          const disableRetryDelay =
            disableAllRetryDelays || disableThisRetryDelay;
          const effectiveDuration = disableRetryDelay ? 0 : durationMs;

          const priorityQueueHash = `${cacheKey}-${stepState.attemptedCount}`;
          // @ts-expect-error priorityQueue is initiated in init
          await this.#engine.priorityQueue.add({
            hash: priorityQueueHash,
            targetTimestamp: Date.now() + effectiveDuration,
            type: "retry",
          });
          await this.#engine.timeoutHandler.release(this.#engine);
          // Race retry wait against the pause signal so pause
          // takes effect immediately during retries
          {
            const retryPauseSignal = this.#engine.pauseController.signal;
            let pausedDuringRetry = false;
            await Promise.race([
              scheduler.wait(effectiveDuration),
              new Promise<void>((resolve) => {
                if (retryPauseSignal.aborted) {
                  resolve();
                  return;
                }
                retryPauseSignal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              }),
            ]);
            const retryStatus = await this.#engine.getStatus();
            if (
              retryStatus === InstanceStatus.Paused ||
              retryStatus === InstanceStatus.WaitingForPause
            ) {
              pausedDuringRetry = true;
            }
            if (pausedDuringRetry) {
              throw new Error(ABORT_REASONS.USER_PAUSE, { cause: e });
            }
          }

          // if it ever reaches here, we can try to remove it from the priority queue since it's no longer useful
          // @ts-expect-error priorityQueue is initiated in init
          this.#engine.priorityQueue.remove({
            hash: priorityQueueHash,
            type: "retry",
          });

          return doWrapper(doWrapperClosure);
        } else {
          await this.#engine.timeoutHandler.release(this.#engine);
          // Clean up any leftover stream chunks on retry exhaustion
          try {
            await rollbackStreamOutput(
              this.#state.storage,
              cacheKey,
              stepState.attemptedCount,
            );
          } catch {
            // Best-effort cleanup
          }
          this.#engine.writeLog(
            events.failure,
            cacheKey,
            stepNameWithCounter,
            {},
          );
          this.#registerRollback({
            cacheKey,
            rollbackFn,
            stepContext: forwardStepContext(),
            rollbackConfig,
          });

          await this.#state.storage.put(errorKey, error);
          throw error;
        }
      }

      this.#engine.writeLog(events.success, cacheKey, stepNameWithCounter, {
        // TODO (WOR-86): Add limits, figure out serialization
        result: lastStreamMeta ? undefined : result,
        ...(lastStreamMeta && {
          streamOutput: { cacheKey, meta: lastStreamMeta },
        }),
      });
      this.#registerRollback({
        cacheKey,
        rollbackFn,
        stepContext: forwardStepContext(),
        output: result,
        rollbackConfig,
      });
      await this.#engine.timeoutHandler.release(this.#engine);
      return result;
    };

    const result = await doWrapper(closure);

    // Check if a pause was requested while this step was running
    await this.#checkForPendingPause();

    return result;
  }

  async sleep(name: string, duration: WorkflowSleepDuration): Promise<void> {
    if (typeof duration == "string") {
      duration = ms(duration);
    }

    const hash = await computeHash(name + duration.toString());
    const count = this.#getCount("sleep-" + name + duration.toString());
    const cacheKey = `${hash}-${count}`;
    const sleepNameWithCounter = `${name}-${count}`;

    const sleepKey = `${cacheKey}-value`;
    const sleepLogWrittenKey = `${cacheKey}-log-written`;
    const maybeResult = await this.#state.storage.get(sleepKey);

    const sleepNameCountHash = await computeHash(
      name + this.#getCount("sleep-" + name),
    );
    const disableThisSleep = await this.#state.storage.get(
      `${MODIFIER_KEYS.DISABLE_SLEEP}${sleepNameCountHash}`,
    );
    const disableAllSleeps = await this.#state.storage.get(
      MODIFIER_KEYS.DISABLE_ALL_SLEEPS,
    );

    const disableSleep = disableAllSleeps || disableThisSleep;

    if (maybeResult != undefined) {
      // @ts-expect-error priorityQueue is initiated in init
      const entryPQ = this.#engine.priorityQueue.getFirst(
        (a) => a.hash === cacheKey && a.type === "sleep",
      );
      // in case the engine dies while sleeping and wakes up before the retry period
      if (entryPQ !== undefined) {
        await scheduler.wait(
          disableSleep ? 0 : entryPQ.targetTimestamp - Date.now(),
        );
        // @ts-expect-error priorityQueue is initiated in init
        this.#engine.priorityQueue.remove({ hash: cacheKey, type: "sleep" });
      }
      const shouldWriteLog =
        (await this.#state.storage.get(sleepLogWrittenKey)) == undefined;
      if (shouldWriteLog) {
        this.#engine.writeLog(
          InstanceEvent.SLEEP_COMPLETE,
          cacheKey,
          sleepNameWithCounter,
          {},
        );
        await this.#state.storage.put(sleepLogWrittenKey, true);
      }
      return;
    }

    this.#engine.writeLog(
      InstanceEvent.SLEEP_START,
      cacheKey,
      sleepNameWithCounter,
      {
        durationMs: duration,
      },
    );
    const instanceMetadata =
      await this.#state.storage.get<InstanceMetadata>(INSTANCE_METADATA);
    if (!instanceMetadata) {
      throw new Error("instanceMetadata is undefined");
    }

    // TODO(lduarte): not sure of this order of operations
    await this.#state.storage.put(sleepKey, true); // Any value will do for cache hit

    // @ts-expect-error priorityQueue is initiated in init
    await this.#engine.priorityQueue.add({
      hash: cacheKey,
      targetTimestamp: Date.now() + (disableSleep ? 0 : duration),
      type: "sleep",
    });

    // Race the sleep against the pause signal
    const pauseSignal = this.#engine.pauseController.signal;
    const sleepDuration = disableSleep ? 0 : duration;

    let pausedDuringSleep = false;
    await Promise.race([
      scheduler.wait(sleepDuration),
      new Promise<void>((resolve) => {
        if (pauseSignal.aborted) {
          resolve();
          return;
        }
        pauseSignal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      }),
    ]);

    // Check if we were paused during the sleep
    const statusAfterSleep = await this.#engine.getStatus();
    if (
      statusAfterSleep === InstanceStatus.Paused ||
      statusAfterSleep === InstanceStatus.WaitingForPause
    ) {
      pausedDuringSleep = true;
    }

    if (pausedDuringSleep) {
      // Throw pause error
      throw new Error(ABORT_REASONS.USER_PAUSE);
    }

    this.#engine.writeLog(
      InstanceEvent.SLEEP_COMPLETE,
      cacheKey,
      sleepNameWithCounter,
      {},
    );
    await this.#state.storage.put(sleepLogWrittenKey, true);

    // @ts-expect-error priorityQueue is initiated in init
    this.#engine.priorityQueue.remove({ hash: cacheKey, type: "sleep" });
  }

  async sleepUntil(name: string, timestamp: Date | number): Promise<void> {
    if (timestamp instanceof Date) {
      timestamp = timestamp.valueOf();
    }

    const now = Date.now();
    // timestamp needs to be in the future, throw if not
    if (timestamp < now) {
      throw new Error(
        "You can't sleep until a time in the past, time-traveler",
      );
    }

    return this.sleep(name, timestamp - now);
  }

  async waitForEvent<T>(
    name: string,
    options: {
      type: string;
      timeout?: string | number;
    },
  ): Promise<WorkflowStepEvent<T>> {
    if (!options.timeout) {
      options.timeout = "24 hours";
    }

    const count = this.#getCount("waitForEvent-" + name);
    const waitForEventNameWithCounter = `${name}-${count}`;
    const hash = await computeHash(waitForEventNameWithCounter);
    const cacheKey = `${hash}-${count}`;
    const waitForEventKey = `${cacheKey}-value`;
    const errorKey = `${cacheKey}-error`;

    const pendingWaiterRegistered = `${cacheKey}-pending`;

    const timeoutError = new WorkflowTimeoutError(
      `Execution timed out after ${ms(options.timeout)}ms`,
    ) as Error & UserErrorField;

    const maybeResult = await this.#state.storage.get<Event>(waitForEventKey);

    if (maybeResult) {
      const shouldWriteLog =
        (await this.#state.storage.get(waitForEventKey)) == undefined;
      if (shouldWriteLog) {
        this.#engine.writeLog(
          InstanceEvent.WAIT_COMPLETE,
          cacheKey,
          waitForEventNameWithCounter,
          maybeResult,
        );
      }
      return maybeResult as WorkflowStepEvent<T>;
    }
    const maybeError: (Error & UserErrorField) | undefined =
      (await this.#state.storage.get(errorKey)) as Error | undefined;

    if (maybeError) {
      maybeError.isUserError = true;
      throw maybeError;
    }

    const maybeRegistered = await this.#state.storage.get(
      pendingWaiterRegistered,
    );

    if (!maybeRegistered) {
      this.#engine.writeLog(
        InstanceEvent.WAIT_START,
        cacheKey,
        waitForEventNameWithCounter,
        {
          event: options.type,
        },
      );

      await this.#state.storage.put(pendingWaiterRegistered, true);
    }

    // if there's a timeout on the PQ we pop it, because we wont need it
    // @ts-expect-error priorityQueue is initiated in init
    const timeoutEntryPQ = this.#engine.priorityQueue.getFirst(
      (a) => a.hash === cacheKey && a.type === "timeout",
    );
    const forceEventTimeout = await this.#state.storage.get(
      `${MODIFIER_KEYS.FORCE_EVENT_TIMEOUT}${waitForEventKey}`,
    );
    if (
      (timeoutEntryPQ === undefined &&
        this.#engine.priorityQueue !== undefined &&
        this.#engine.priorityQueue.checkIfExistedInPast({
          hash: cacheKey,
          type: "timeout",
        })) ||
      (timeoutEntryPQ !== undefined &&
        timeoutEntryPQ.targetTimestamp < Date.now()) ||
      forceEventTimeout
    ) {
      this.#engine.writeLog(
        InstanceEvent.WAIT_TIMED_OUT,
        cacheKey,
        waitForEventNameWithCounter,
        {
          name: timeoutError.name,
          message: timeoutError.message,
        },
      );
      await this.#state.storage.put(errorKey, timeoutError);
      throw timeoutError;
    }

    const timeoutPromise = async (timeoutToWait: number, addToPQ: boolean) => {
      const priorityQueueHash = cacheKey;
      if (addToPQ) {
        // @ts-expect-error priorityQueue is initiated in init
        await this.#engine.priorityQueue.add({
          hash: priorityQueueHash,
          targetTimestamp: Date.now() + timeoutToWait,
          type: "timeout",
        });
      }
      await scheduler.wait(timeoutToWait);
      // if we reach here, means that we can try to delete the timeout from the PQ
      // because we managed to wait in the same lifetime

      // @ts-expect-error priorityQueue is initiated in init
      this.#engine.priorityQueue.remove({
        hash: priorityQueueHash,
        type: "timeout",
      });
      // NOTE(lduarte): marking errors as user error allows the observability layer to avoid leaking
      // user errors to sentry while making everything more observable. `isUserError` is not serialized
      // into userland code due to how workerd serialzises errors over RPC - we also set it as undefined
      // in the obs layer in case changes to workerd happen
      const error = timeoutError;
      error.isUserError = true;
      throw error;
    };

    const eventPromise = new Promise<Event>((resolve) => {
      // TODO: This might need to be the name, not the event type

      const eventTypeQueue = this.#engine.eventMap.get(options.type);
      if (eventTypeQueue) {
        const event = eventTypeQueue.shift();
        if (event) {
          this.#engine.eventMap.set(options.type, eventTypeQueue);
          return resolve(event);
        }
      }
      const callbacks = this.#engine.waiters.get(options.type) ?? [];
      callbacks.push([cacheKey, resolve]);

      this.#engine.waiters.set(options.type, callbacks);
    });

    // Race event, timeout, and pause signal. The pause promise resolves
    // when the race settles via event/timeout before the pause signal fires
    const pauseSignal = this.#engine.pauseController.signal;
    const pausePromise = new Promise<void>((resolve) => {
      if (pauseSignal.aborted) {
        resolve();
        return;
      }
      pauseSignal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });

    const raceResult = await Promise.race([
      eventPromise,
      timeoutEntryPQ !== undefined
        ? timeoutPromise(timeoutEntryPQ.targetTimestamp - Date.now(), false)
        : timeoutPromise(ms(options.timeout), true),
      pausePromise,
    ]).catch(async (error) => {
      const callbacks = this.#engine.waiters.get(options.type);
      if (callbacks) {
        const idx = callbacks.findIndex(([key]) => key === cacheKey);
        if (idx !== -1) {
          callbacks.splice(idx, 1);
        }
      }

      this.#engine.writeLog(
        InstanceEvent.WAIT_TIMED_OUT,
        cacheKey,
        waitForEventNameWithCounter,
        error,
      );
      await this.#state.storage.put(errorKey, error);
      throw error;
    });

    // Pause signal won the race — throw to stop the workflow
    if (raceResult === undefined) {
      throw new Error(ABORT_REASONS.USER_PAUSE);
    }

    this.#engine.writeLog(
      InstanceEvent.WAIT_COMPLETE,
      cacheKey,
      waitForEventNameWithCounter,
      raceResult as Event,
    );
    await this.#state.storage.put(waitForEventKey, raceResult);

    return raceResult as WorkflowStepEvent<T>;
  }
}
