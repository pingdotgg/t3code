import type { EnvironmentId } from "@t3tools/contracts";

const ADD_STACK_STEP_EVENT = "t3code:add-stack-step";

interface AddStackStepTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

export function requestAddStackStep(target: AddStackStepTarget): boolean {
  return !window.dispatchEvent(
    new CustomEvent(ADD_STACK_STEP_EVENT, {
      cancelable: true,
      detail: target,
    }),
  );
}

export function onAddStackStep(listener: (target: AddStackStepTarget) => boolean): () => void {
  const handler = (event: Event) => {
    if (listener((event as CustomEvent<AddStackStepTarget>).detail)) event.preventDefault();
  };
  window.addEventListener(ADD_STACK_STEP_EVENT, handler);
  return () => window.removeEventListener(ADD_STACK_STEP_EVENT, handler);
}
