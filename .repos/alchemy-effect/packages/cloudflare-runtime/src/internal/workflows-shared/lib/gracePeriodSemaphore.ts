// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { ms } from "itty-time";
import type { Engine } from "../engine.ts";
import type { WorkflowSleepDuration } from "cloudflare:workers";

export const ENGINE_TIMEOUT = ms("5 minutes" satisfies WorkflowSleepDuration);

let latestGracePeriodTimestamp: number | undefined = undefined;

export type WaitingPromiseType = "pause";

export type GracePeriodCallback = (engine: Engine, timeoutMs: number) => void;

export class GracePeriodSemaphore {
  #counter: number = 0;
  readonly callback: GracePeriodCallback;
  readonly timeoutMs: number;
  #waitingPromises: Array<{
    rejectCallback: () => void;
    resolveCallback: (value: unknown) => void;
    type: WaitingPromiseType;
  }> = [];
  #canInitiateSteps = true;
  #waitingSteps: Array<{
    rejectCallback: () => void;
    resolveCallback: (value: unknown) => void;
  }> = [];

  constructor(callback: GracePeriodCallback, timeoutMs: number) {
    this.callback = callback;
    this.timeoutMs = timeoutMs;
  }

  // acquire takes engine to be the same as release
  async acquire(_engine: Engine) {
    if (!this.#canInitiateSteps) {
      await new Promise((resolve, reject) => {
        this.#waitingSteps.push({
          resolveCallback: resolve,
          rejectCallback: reject,
        });
      });
    }
    // when the counter goes from 0 to 1 - we can safely reject the previous grace period
    if (this.#counter == 0) {
      latestGracePeriodTimestamp = undefined;
    }
    this.#counter += 1;
  }

  async release(engine: Engine) {
    this.#counter = Math.max(this.#counter - 1, 0);
    if (this.#counter == 0) {
      // Trigger timeout promise, no need to await here,
      // this can be triggered slightly after it's not time sensitive
      this.callback(engine, this.timeoutMs);
      // Resolve any promises waiting for all steps to finish (e.g. pause)
      for (const promise of this.#waitingPromises) {
        promise.resolveCallback(undefined);
      }
      this.#waitingPromises = [];
    }
  }

  async waitUntilNothingIsRunning(
    type: WaitingPromiseType,
    callback: () => Promise<void>,
  ): Promise<void> {
    this.#canInitiateSteps = false;
    if (this.#counter > 0) {
      try {
        await new Promise((resolve, reject) => {
          this.#waitingPromises.push({
            resolveCallback: resolve,
            rejectCallback: reject,
            type,
          });
        });
      } catch {
        // If the promise gets rejected (e.g. resume cancels the pause),
        // allow steps to run again and unblock any that were waiting
        for (const promise of this.#waitingSteps) {
          promise.resolveCallback(undefined);
        }
        this.#waitingSteps = [];
        this.#canInitiateSteps = true;
        return;
      }
    }
    await callback();
    // Allow steps to run again and unblock any that were waiting
    for (const promise of this.#waitingSteps) {
      promise.resolveCallback(undefined);
    }
    this.#waitingSteps = [];
    this.#canInitiateSteps = true;
  }

  cancelWaitingPromisesByType(type: WaitingPromiseType) {
    const sameTypePromises = this.#waitingPromises.filter((val) => val.type === type);
    if (sameTypePromises.length === 0) {
      return;
    }

    for (const promise of sameTypePromises) {
      promise.rejectCallback();
    }

    this.#waitingPromises = this.#waitingPromises.filter((val) => val.type !== type);

    this.#canInitiateSteps = true;

    // Unblock any steps that were waiting to acquire while the pause was pending
    for (const promise of this.#waitingSteps) {
      promise.resolveCallback(undefined);
    }
    this.#waitingSteps = [];
  }

  dispose() {
    // Reject all waiting step promises so they stop blocking
    for (const promise of this.#waitingSteps) {
      promise.rejectCallback();
    }
    this.#waitingSteps = [];

    // Reject all waiting promises
    for (const promise of this.#waitingPromises) {
      promise.rejectCallback();
    }
    this.#waitingPromises = [];

    this.#canInitiateSteps = false;
  }

  isRunningStep() {
    return this.#counter > 0;
  }
}

export const startGracePeriod: GracePeriodCallback = async (engine: Engine, timeoutMs: number) => {
  const gracePeriodHandler = async () => {
    const thisTimestamp = new Date().valueOf();

    // TODO: Should the grace period be 5 mins every time or 5 mins across lifetimes?
    // At the moment, it looks like this will reset to 5 mins if a metal crashes
    // There might possibly waste memory waiting for `timeoutMs` every time
    // We should eventually strongly persist and respect this value across lifetimes

    // We are starting a new grace period
    // 1. There should not be one already set
    // 2. Or if there is, it should be in the past
    if (!(latestGracePeriodTimestamp === undefined || latestGracePeriodTimestamp < thisTimestamp)) {
      throw new Error(
        "Can't start grace period since there is already an active one started on " +
          latestGracePeriodTimestamp,
      );
    }

    latestGracePeriodTimestamp = thisTimestamp;
    await scheduler.wait(timeoutMs);
    if (thisTimestamp !== latestGracePeriodTimestamp || engine.timeoutHandler.isRunningStep()) {
      return;
    }
    // priorityQueue is set before the user code runs which implies that a grace period cannot start
    // before init finishes where it is set

    // Ensure next alarm is set before we abort
    await engine.priorityQueue?.handleNextAlarm();
    // await engine.abort(ABORT_REASONS.GRACE_PERIOD_COMPLETE);
  };
  void gracePeriodHandler().catch(() => {
    // Swallow — the engine is shutting down (abort kills the context,
    // which rejects the scheduler.wait inside gracePeriodHandler)
  });
};
