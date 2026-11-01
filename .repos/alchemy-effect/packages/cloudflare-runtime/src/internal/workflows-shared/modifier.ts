// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { RpcTarget } from "cloudflare:workers";
import { computeHash } from "./lib/cache.ts";
import { isReadableStreamLike, writeStreamOutput } from "./lib/streams.ts";
import type { Event } from "./context.ts";
import type { Engine } from "./engine.ts";

export type StepSelector = {
  name: string;
  index?: number;
};

type UserEvent = {
  type: string;
  payload: unknown;
};

// KV key prefixes/values used by the modifier/mock system
export const MODIFIER_KEYS = {
  REPLACE_RESULT: "replace-result-",
  MOCK_STEP_ERROR: "mock-step-error-",
  MOCK_EVENT: "mock-event-",
  FORCE_STEP_TIMEOUT: "force-step-timeout-",
  FORCE_EVENT_TIMEOUT: "force-event-timeout-",
  FAILURE_INDEX: "failure-index-",
  DISABLE_SLEEP: "disable-sleep-",
  DISABLE_ALL_SLEEPS: "disableAllSleeps",
  DISABLE_RETRY_DELAY: "disable-retry-delay-",
  DISABLE_ALL_RETRY_DELAYS: "disableAllRetryDelays",
} as const;

export function isModifierKey(key: string): boolean {
  return Object.values(MODIFIER_KEYS).some((v) => key.startsWith(v));
}

export class WorkflowInstanceModifier extends RpcTarget {
  #engine: Engine;
  #state: DurableObjectState;

  constructor(engine: Engine, state: DurableObjectState) {
    super();
    this.#engine = engine;
    this.#state = state;
  }

  async #getWaitForEventCacheKey(step: StepSelector): Promise<string> {
    let count = 1;
    if (step.index) {
      count = step.index;
    }
    const name = `${step.name}-${count}`;
    const hash = await computeHash(name);
    const cacheKey = `${hash}-${count}`;
    const waitForEventKey = `${cacheKey}-value`;

    return waitForEventKey;
  }

  async #getBaseCacheKey(step: StepSelector): Promise<string> {
    const hash = await computeHash(step.name);
    let count = 1;
    if (step.index) {
      count = step.index;
    }
    return `${hash}-${count}`;
  }

  async #getStepCacheKey(step: StepSelector): Promise<string> {
    const baseCacheKey = await this.#getBaseCacheKey(step);
    return `${baseCacheKey}-value`;
  }

  #getAndIncrementCounter = async (valueKey: string, by: number) => {
    const counterKey = `${MODIFIER_KEYS.FAILURE_INDEX}${valueKey}`;
    const next = (await this.#state.storage.get<number>(counterKey)) ?? 1;
    await this.#state.storage.put(counterKey, next + by);
    return next;
  };

  async #getSleepStepDisableKey(step: StepSelector): Promise<string> {
    let count = 1;
    if (step.index) {
      count = step.index;
    }
    const sleepNameCountHash = await computeHash(step.name + count);

    return `${MODIFIER_KEYS.DISABLE_SLEEP}${sleepNameCountHash}`;
  }

  async disableSleeps(steps?: Array<StepSelector>): Promise<void> {
    if (!steps) {
      await this.#state.storage.put(MODIFIER_KEYS.DISABLE_ALL_SLEEPS, true);
    } else {
      for (const step of steps) {
        const sleepDisableKey = await this.#getSleepStepDisableKey(step);
        await this.#state.storage.put(sleepDisableKey, true);
      }
    }
  }

  async disableRetryDelays(steps?: Array<StepSelector>): Promise<void> {
    if (!steps) {
      await this.#state.storage.put(
        MODIFIER_KEYS.DISABLE_ALL_RETRY_DELAYS,
        true,
      );
    } else {
      for (const step of steps) {
        const valueKey = await this.#getStepCacheKey(step);
        await this.#state.storage.put(
          `${MODIFIER_KEYS.DISABLE_RETRY_DELAY}${valueKey}`,
          true,
        );
      }
    }
  }

  // step.do() flow: It first checks if a result or error is already in the cache and, if so, returns it immediately.
  // If nothing is in the cache, it checks for remaining attempts and runs the user's code against the defined timeout.
  // Since `step.do()` performs this initial cache check, directly changing the `valueKey` would cause it to
  // assume the value was pre-cached, preventing it from writing any logs about the step's execution state.
  // Storing the value under a separate key is crucial because it ensures all execution logs for the step are
  // generated, rather than the step being skipped due to a premature cache hit.
  async mockStepResult(step: StepSelector, stepResult: unknown): Promise<void> {
    const valueKey = await this.#getStepCacheKey(step);

    if (
      await this.#state.storage.get(
        `${MODIFIER_KEYS.REPLACE_RESULT}${valueKey}`,
      )
    ) {
      throw new Error(
        `[WorkflowIntrospector] Trying to mock step '${step.name}' multiple times!`,
      );
    }

    if (isReadableStreamLike(stepResult)) {
      // ReadableStream is not structured-cloneable, so we consume it eagerly
      // and store the chunks via the streaming infrastructure. We use attempt 0
      // to distinguish mock chunks from real execution attempts (which start at 1).
      const baseCacheKey = await this.#getBaseCacheKey(step);
      const streamMeta = await writeStreamOutput({
        storage: this.#state.storage,
        cacheKey: baseCacheKey,
        attempt: 0,
        stream: stepResult,
        skipMetaWrite: true,
      });

      await this.#state.storage.put(
        `${MODIFIER_KEYS.REPLACE_RESULT}${valueKey}`,
        {
          __mockStreamOutput: true,
          cacheKey: baseCacheKey,
          meta: streamMeta,
        },
      );
    } else {
      await this.#state.storage.put(
        `${MODIFIER_KEYS.REPLACE_RESULT}${valueKey}`,
        stepResult,
      );
    }
  }

  // Same logic of `mockStepResult` but stores an error instead of a value.
  async mockStepError(
    step: StepSelector,
    error: Error,
    times?: number,
  ): Promise<void> {
    const valueKey = await this.#getStepCacheKey(step);
    const serializableError = {
      name: error.name,
      message: error.message,
    };

    if (
      await this.#state.storage.get(
        `${MODIFIER_KEYS.REPLACE_RESULT}${valueKey}`,
      )
    ) {
      throw new Error(
        `[WorkflowIntrospector] Trying to mock error on step '${step.name}' after mocking its result!`,
      );
    }

    if (times) {
      const start = await this.#getAndIncrementCounter(valueKey, times);
      const mockErrorsPuts = Array.from({ length: times }, (_, i) => {
        const attempt = start + i;
        const mockErrorKey = `${MODIFIER_KEYS.MOCK_STEP_ERROR}${valueKey}-${attempt}`;
        return this.#state.storage.put(mockErrorKey, serializableError);
      });

      await Promise.all(mockErrorsPuts);
    } else {
      const mockErrorKey = `${MODIFIER_KEYS.MOCK_STEP_ERROR}${valueKey}`;
      await this.#state.storage.put(mockErrorKey, serializableError);
    }
  }

  async forceStepTimeout(step: StepSelector, times?: number) {
    const valueKey = await this.#getStepCacheKey(step);

    if (
      await this.#state.storage.get(
        `${MODIFIER_KEYS.REPLACE_RESULT}${valueKey}`,
      )
    ) {
      throw new Error(
        `[WorkflowIntrospector] Trying to force timeout on step '${step.name}' after mocking its result!`,
      );
    }

    if (times) {
      const start = await this.#getAndIncrementCounter(valueKey, times);
      const forceTimeouts = Array.from({ length: times }, (_, i) => {
        const attempt = start + i;
        const forceStepTimeoutKey = `${MODIFIER_KEYS.FORCE_STEP_TIMEOUT}${valueKey}-${attempt}`;
        return this.#state.storage.put(forceStepTimeoutKey, true);
      });

      await Promise.all(forceTimeouts);
    } else {
      const forceStepTimeoutKey = `${MODIFIER_KEYS.FORCE_STEP_TIMEOUT}${valueKey}`;
      await this.#state.storage.put(forceStepTimeoutKey, true);
    }
  }

  async mockEvent(event: UserEvent): Promise<void> {
    const myEvent: Event = {
      timestamp: new Date(),
      payload: event.payload,
      type: event.type,
    };

    await this.#state.storage.put(
      `${MODIFIER_KEYS.MOCK_EVENT}${event.type}`,
      true,
    );
    await this.#engine.receiveEvent(myEvent);
  }

  async forceEventTimeout(step: StepSelector): Promise<void> {
    const waitForEventKey = await this.#getWaitForEventCacheKey(step);
    await this.#state.storage.put(
      `${MODIFIER_KEYS.FORCE_EVENT_TIMEOUT}${waitForEventKey}`,
      true,
    );
  }
}
