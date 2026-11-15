import {
  BOAT_CLOUD_START_STEPS,
  type BoatCloudStartStep,
  type BoatCloudStepProgress,
} from "@t3tools/contracts";

/** One Boat cloud start as the client shows it: the holder's steps, then the client's own. */
export interface BoatCloudStartProgress {
  readonly steps: ReadonlyArray<BoatCloudStepProgress>;
  readonly error: string | null;
}

const HOLDER_STEPS: ReadonlySet<BoatCloudStartStep> = new Set(["machine", "server", "repository"]);

export function startingProgress(repositoryName: string | null): BoatCloudStartProgress {
  return {
    steps: BOAT_CLOUD_START_STEPS.map((step) => ({
      step,
      state: step === "machine" ? "active" : "pending",
      detail: step === "repository" ? repositoryName : null,
    })),
    error: null,
  };
}

/** Takes the holder's latest report for its steps, keeping a detail the report leaves out. */
export function withHolderSteps(
  progress: BoatCloudStartProgress,
  reported: ReadonlyArray<BoatCloudStepProgress>,
): BoatCloudStartProgress {
  return {
    ...progress,
    steps: progress.steps.map((entry) => {
      const report = HOLDER_STEPS.has(entry.step)
        ? reported.find((candidate) => candidate.step === entry.step)
        : undefined;
      return report ? { ...report, detail: report.detail ?? entry.detail } : entry;
    }),
  };
}

/** Marks `step` done and starts the next pending one. */
export function completeStep(
  progress: BoatCloudStartProgress,
  step: BoatCloudStartStep,
): BoatCloudStartProgress {
  const done = progress.steps.map((entry) =>
    entry.step === step ? { ...entry, state: "done" as const } : entry,
  );
  if (done.some((entry) => entry.state === "active")) return { ...progress, steps: done };
  const next = done.findIndex((entry) => entry.state === "pending");
  return {
    ...progress,
    steps: done.map((entry, index) =>
      index === next ? { ...entry, state: "active" as const } : entry,
    ),
  };
}

/**
 * A successful acquire means the holder finished its steps, even when the
 * status stream dropped the last update before the start was removed.
 */
export function markAcquired(progress: BoatCloudStartProgress): BoatCloudStartProgress {
  let next = progress;
  for (const step of HOLDER_STEPS) next = completeStep(next, step);
  return next;
}

/**
 * Keeps a failure the holder reported, and stops the steps that ran beside it;
 * otherwise fails whatever was running, or the next step when nothing was.
 */
export function failProgress(
  progress: BoatCloudStartProgress,
  error: string,
): BoatCloudStartProgress {
  if (progress.steps.some((entry) => entry.state === "failed")) {
    return {
      error,
      steps: progress.steps.map((entry) =>
        entry.state === "active" ? { ...entry, state: "pending" as const } : entry,
      ),
    };
  }
  const active = progress.steps.some((entry) => entry.state === "active");
  const firstPending = progress.steps.findIndex((entry) => entry.state === "pending");
  return {
    error,
    steps: progress.steps.map((entry, index) =>
      (active ? entry.state === "active" : index === firstPending)
        ? { ...entry, state: "failed" as const }
        : entry,
    ),
  };
}
