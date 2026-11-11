export const COMPOSER_TYPING_IDLE_MS = 1500;

export function createComposerTypingGuardState() {
  return {
    seen: new Set<string>(),
    held: new Set<string>(),
    focused: false,
    enabled: true,
    lastTypedAt: -Infinity,
  };
}

type TypingGuardEvent =
  | { type: "requests"; requestIds: readonly string[]; now: number }
  | { type: "type"; now: number }
  | { type: "enabled"; enabled: boolean }
  | { type: "focus" | "blur" | "send" | "idle" | "flush" };

export function updateComposerTypingGuard(
  state: ReturnType<typeof createComposerTypingGuardState>,
  event: TypingGuardEvent,
) {
  switch (event.type) {
    case "enabled": {
      if (event.enabled === state.enabled) return state;
      if (event.enabled) return { ...state, enabled: true };
      return {
        ...state,
        enabled: false,
        held: state.held.size === 0 ? state.held : new Set<string>(),
        lastTypedAt: -Infinity,
      };
    }
    case "requests": {
      const seen = new Set(state.seen);
      const held = new Set([...state.held].filter((id) => event.requestIds.includes(id)));
      for (const id of event.requestIds) {
        if (
          state.enabled &&
          !seen.has(id) &&
          state.focused &&
          event.now - state.lastTypedAt < COMPOSER_TYPING_IDLE_MS
        ) {
          held.add(id);
        }
        seen.add(id);
      }
      return {
        ...state,
        seen,
        held:
          held.size === state.held.size && [...held].every((id) => state.held.has(id))
            ? state.held
            : held,
      };
    }
    case "type":
      return state.enabled ? { ...state, lastTypedAt: event.now } : state;
    case "focus":
      return { ...state, focused: true };
    case "blur":
    case "send":
    case "idle":
    case "flush":
      return {
        ...state,
        held: state.held.size === 0 ? state.held : new Set<string>(),
        lastTypedAt: -Infinity,
        focused: event.type === "blur" ? false : state.focused,
      };
  }
}
