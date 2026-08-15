export type ThreadFeedLiveFollowEvent =
  | { readonly type: "reset" }
  | { readonly type: "user-scroll-begin" }
  | {
      readonly type: "user-scroll-end";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    }
  | {
      readonly type: "scroll";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    };

export function resolveThreadFeedLiveFollow(
  current: boolean,
  event: ThreadFeedLiveFollowEvent,
): boolean {
  switch (event.type) {
    case "reset":
      return true;
    case "user-scroll-begin":
      return false;
    case "user-scroll-end":
      return event.userScrollSessionActive ? event.isAtEnd : current;
    case "scroll":
      if (event.userScrollSessionActive) {
        return false;
      }
      if (event.isAtEnd) {
        return true;
      }
      return current;
  }
}

export function shouldShowThreadFeedScrollToEnd(input: {
  readonly endFollowEnabled: boolean;
  readonly isAtEnd: boolean;
}): boolean {
  return !input.endFollowEnabled && !input.isAtEnd;
}

export interface ThreadFeedAtEndState {
  readonly threadKey: string;
  readonly isAtEnd: boolean;
}

export function resolveThreadFeedAtEndState(
  current: ThreadFeedAtEndState,
  selectedThreadKey: string,
): ThreadFeedAtEndState {
  if (current.threadKey === selectedThreadKey) {
    return current;
  }
  return { threadKey: selectedThreadKey, isAtEnd: true };
}
