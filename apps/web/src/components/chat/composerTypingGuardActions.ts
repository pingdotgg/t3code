import { create } from "zustand";

type TypingGuardActions = {
  readonly heldCount: number;
  readonly flush: (() => void) | null;
};

export const useComposerTypingGuardActions = create<TypingGuardActions>(() => ({
  heldCount: 0,
  flush: null,
}));

export function publishComposerTypingGuardActions(
  next: { readonly heldCount: number; readonly flush: () => void } | null,
) {
  useComposerTypingGuardActions.setState(
    next === null
      ? { heldCount: 0, flush: null }
      : { heldCount: next.heldCount, flush: next.flush },
  );
}

export function flushComposerTypingGuardHeldRequests() {
  const current = useComposerTypingGuardActions.getState();
  if (current.heldCount === 0 || current.flush === null) return false;
  current.flush();
  return true;
}
