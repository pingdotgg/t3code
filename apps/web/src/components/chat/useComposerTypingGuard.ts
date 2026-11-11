import { useEffect, useState } from "react";
import {
  COMPOSER_TYPING_IDLE_MS,
  createComposerTypingGuardState,
  updateComposerTypingGuard,
} from "./composerTypingGuard";

export function useComposerTypingGuard(
  scope: string,
  requestIds: readonly string[],
  enabled = true,
) {
  const requestsKey = JSON.stringify(requestIds);
  const [snapshot, setSnapshot] = useState(() => ({
    scope,
    requestsKey,
    enabled,
    state: updateComposerTypingGuard(
      updateComposerTypingGuard(createComposerTypingGuardState(), { type: "enabled", enabled }),
      {
        type: "requests",
        requestIds,
        now: Date.now(),
      },
    ),
  }));
  const state = snapshot.state;
  if (
    snapshot.scope !== scope ||
    snapshot.requestsKey !== requestsKey ||
    snapshot.enabled !== enabled
  ) {
    setSnapshot((current) => {
      let nextState =
        current.scope === scope
          ? current.state
          : { ...createComposerTypingGuardState(), focused: current.state.focused };
      if (current.enabled !== enabled || nextState.enabled !== enabled) {
        nextState = updateComposerTypingGuard(nextState, { type: "enabled", enabled });
      }
      return {
        scope,
        requestsKey,
        enabled,
        state: updateComposerTypingGuard(nextState, {
          type: "requests",
          requestIds,
          now: Date.now(),
        }),
      };
    });
  }
  const dispatch = (event: Parameters<typeof updateComposerTypingGuard>[1]) => {
    setSnapshot((current) => ({
      ...current,
      state: updateComposerTypingGuard(current.state, event),
    }));
  };
  const onDraftChange = () => dispatch({ type: "type", now: Date.now() });
  const onFocus = () => dispatch({ type: "focus" });
  const onBlur = () => dispatch({ type: "blur" });
  const onSend = () => dispatch({ type: "send" });
  const flushNow = () => dispatch({ type: "flush" });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules a timer that releases held requests once typing has been idle long enough
  useEffect(() => {
    if (state.held.size === 0) return;
    const timeout = window.setTimeout(
      () => dispatch({ type: "idle" }),
      Math.max(0, state.lastTypedAt + COMPOSER_TYPING_IDLE_MS - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [state.held, state.lastTypedAt, dispatch]);
  return {
    heldRequestIds: state.held,
    onDraftChange,
    onFocus,
    onBlur,
    onSend,
    flushNow,
  };
}
