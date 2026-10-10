import { useCallback, useEffect, useState } from "react";
import {
  COMPOSER_TYPING_IDLE_MS,
  createComposerTypingGuardState,
  updateComposerTypingGuard,
} from "./composerTypingGuard";

export function useComposerTypingGuard(scope: string, requestIds: readonly string[]) {
  const requestsKey = JSON.stringify(requestIds);
  const [snapshot, setSnapshot] = useState(() => ({
    scope,
    requestsKey,
    state: updateComposerTypingGuard(createComposerTypingGuardState(), {
      type: "requests",
      requestIds,
      now: Date.now(),
    }),
  }));
  const state = snapshot.state;
  if (snapshot.scope !== scope || snapshot.requestsKey !== requestsKey) {
    setSnapshot((current) => ({
      scope,
      requestsKey,
      state: updateComposerTypingGuard(
        current.scope === scope
          ? current.state
          : { ...createComposerTypingGuardState(), focused: current.state.focused },
        { type: "requests", requestIds, now: Date.now() },
      ),
    }));
  }
  const dispatch = useCallback((event: Parameters<typeof updateComposerTypingGuard>[1]) => {
    setSnapshot((current) => ({
      ...current,
      state: updateComposerTypingGuard(current.state, event),
    }));
  }, []);
  const onDraftChange = useCallback(() => dispatch({ type: "type", now: Date.now() }), [dispatch]);
  const onFocus = useCallback(() => dispatch({ type: "focus" }), [dispatch]);
  const onBlur = useCallback(() => dispatch({ type: "blur" }), [dispatch]);
  const onSend = useCallback(() => dispatch({ type: "send" }), [dispatch]);
  useEffect(() => {
    if (state.held.size === 0) return;
    const timeout = window.setTimeout(
      () => dispatch({ type: "idle" }),
      Math.max(0, state.lastTypedAt + COMPOSER_TYPING_IDLE_MS - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [state.held, state.lastTypedAt, dispatch]);
  return { heldRequestIds: state.held, onDraftChange, onFocus, onBlur, onSend };
}
