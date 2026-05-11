import { scheduleIdleTask } from "./idleTask";

export interface DiffWorkerPoolLike {
  getDiffRenderOptions(): unknown;
  setRenderOptions(options: unknown): Promise<unknown>;
}

export function warmDiffWorkerPool(
  workerPool: DiffWorkerPoolLike | null | undefined,
): Promise<void> | undefined {
  if (!workerPool) {
    return undefined;
  }

  return workerPool
    .setRenderOptions(workerPool.getDiffRenderOptions())
    .then(() => undefined)
    .catch(() => undefined);
}

export function scheduleDiffWorkerPoolWarmup(
  workerPool: DiffWorkerPoolLike | null | undefined,
  scheduleTask: typeof scheduleIdleTask = scheduleIdleTask,
): (() => void) | undefined {
  if (!workerPool) {
    return undefined;
  }

  return scheduleTask(() => {
    void warmDiffWorkerPool(workerPool);
  });
}
