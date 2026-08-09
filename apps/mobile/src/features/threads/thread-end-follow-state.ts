export type ThreadEndFollowState = {
  readonly threadKey: string;
  readonly enabled: boolean;
};

export type ThreadEndFollowEvent =
  | {
      readonly type: "observed";
      readonly threadKey: string;
      readonly enabled: boolean;
    }
  | { readonly type: "scrollToEnd"; readonly threadKey: string };

export function initialThreadEndFollowState(threadKey: string): ThreadEndFollowState {
  return { threadKey, enabled: true };
}

export function threadEndFollowEnabled(state: ThreadEndFollowState, threadKey: string): boolean {
  return state.threadKey === threadKey ? state.enabled : true;
}

export function reduceThreadEndFollowState(
  state: ThreadEndFollowState,
  event: ThreadEndFollowEvent,
): ThreadEndFollowState {
  if (event.type === "observed") {
    return { threadKey: event.threadKey, enabled: event.enabled };
  }
  return { threadKey: event.threadKey, enabled: true };
}
