export const COMPOSER_TYPING_IDLE_MS = 1500;

export function createComposerTypingGuardState() {
  return {
    seen: new Set<string>(),
    held: new Set<string>(),
    focused: false,
    lastTypedAt: -Infinity,
  };
}

type TypingGuardEvent =
  | { type: "requests"; requestIds: readonly string[]; now: number }
  | { type: "type"; now: number }
  | { type: "focus" | "blur" | "send" | "idle" };

export function updateComposerTypingGuard(
  state: ReturnType<typeof createComposerTypingGuardState>,
  event: TypingGuardEvent,
) {
  switch (event.type) {
    case "requests": {
      const seen = new Set(state.seen);
      const held = new Set([...state.held].filter((id) => event.requestIds.includes(id)));
      for (const id of event.requestIds) {
        if (
          !seen.has(id) &&
          state.focused &&
          event.now - state.lastTypedAt < COMPOSER_TYPING_IDLE_MS
        ) {
          held.add(id);
        }
        seen.add(id);
      }
      return { ...state, seen, held };
    }
    case "type":
      return { ...state, lastTypedAt: event.now };
    case "focus":
      return { ...state, focused: true };
    case "blur":
    case "send":
    case "idle":
      return {
        ...state,
        held: new Set<string>(),
        lastTypedAt: -Infinity,
        focused: event.type === "blur" ? false : state.focused,
      };
  }
}
