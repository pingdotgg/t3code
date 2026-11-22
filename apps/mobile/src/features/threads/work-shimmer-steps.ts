// Each step is a native frame for every working row on screen; a 5 s cycle of 6 steps redraws
// about a quarter as often as the old 2.8 s cycle of 12.
export const SHIMMER_SWEEP_MS = 1_350;
export const SHIMMER_PAUSE_MS = 3_650;
export const SHIMMER_STEPS = 6;
const SHIMMER_STEP_MS = SHIMMER_SWEEP_MS / SHIMMER_STEPS;

// No progress updates run during the pause. Progress 0 and 1 both sit off the
// content, so the cycle only needs steps 1 through SHIMMER_STEPS.
export function startShimmerSteps(progress: { setValue(value: number): void }): () => void {
  let step = 0;
  let timer: ReturnType<typeof setTimeout>;
  const advance = () => {
    step = (step % SHIMMER_STEPS) + 1;
    progress.setValue(step / SHIMMER_STEPS);
    timer = setTimeout(
      advance,
      step === SHIMMER_STEPS ? SHIMMER_PAUSE_MS + SHIMMER_STEP_MS : SHIMMER_STEP_MS,
    );
  };
  timer = setTimeout(advance, SHIMMER_STEP_MS);
  return () => clearTimeout(timer);
}
