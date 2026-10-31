export const SHIMMER_SWEEP_MS = 1_350;
export const SHIMMER_PAUSE_MS = 1_450;
export const SHIMMER_STEPS = 12;
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
