import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const lastTypedAtRef = useRef(-Infinity);
  useLayoutEffect(() => {
    lastTypedAtRef.current = -Infinity;
  }, [scope]);
  if (snapshot.scope !== scope || snapshot.requestsKey !== requestsKey) {
    setSnapshot((current) => ({
      scope,
      requestsKey,
      state: updateComposerTypingGuard(
        current.scope === scope
          ? { ...current.state, lastTypedAt: lastTypedAtRef.current }
          : { ...createComposerTypingGuardState(), focused: current.state.focused },
        { type: "requests", requestIds, now: Date.now() },
      ),
    }));
  }
  // Only the idle deadline changes during typing, not the rendered held requests.
  const dispatch = useCallback((event: Parameters<typeof updateComposerTypingGuard>[1]) => {
    if (event.type === "type") {
      lastTypedAtRef.current = event.now;
      return;
    }
    const lastTypedAt = lastTypedAtRef.current;
    if (event.type === "blur" || event.type === "send" || event.type === "idle") {
      lastTypedAtRef.current = -Infinity;
    }
    setSnapshot((current) => ({
      ...current,
      state: updateComposerTypingGuard({ ...current.state, lastTypedAt }, event),
    }));
  }, []);
  const onDraftChange = useCallback(() => dispatch({ type: "type", now: Date.now() }), [dispatch]);
  const onFocus = useCallback(() => dispatch({ type: "focus" }), [dispatch]);
  const onBlur = useCallback(() => dispatch({ type: "blur" }), [dispatch]);
  const onSend = useCallback(() => dispatch({ type: "send" }), [dispatch]);
  useEffect(() => {
    if (state.held.size === 0) return;
    let timeout: number;
    const releaseWhenIdle = () => {
      const remaining = lastTypedAtRef.current + COMPOSER_TYPING_IDLE_MS - Date.now();
      if (remaining > 0) timeout = window.setTimeout(releaseWhenIdle, remaining);
      else dispatch({ type: "idle" });
    };
    timeout = window.setTimeout(
      releaseWhenIdle,
      Math.max(0, lastTypedAtRef.current + COMPOSER_TYPING_IDLE_MS - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [state.held, dispatch]);
  return { heldRequestIds: state.held, onDraftChange, onFocus, onBlur, onSend };
}
