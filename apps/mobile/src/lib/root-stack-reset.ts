import type { CommonActions, NavigationState } from "@react-navigation/native";

export type RootStackResetAction = ReturnType<typeof CommonActions.reset> & {
  readonly target: string;
};

export interface RootStackNavigation {
  readonly dispatch: (action: RootStackResetAction) => void;
  readonly getParent: () => RootStackNavigation | undefined;
  readonly getState: () => NavigationState | undefined;
  /** Only on the navigation container, whose `getState` stays empty until the first action. */
  readonly getRootState?: () => NavigationState | undefined;
}

/**
 * The root stack's state, read from anywhere. The sidebar and rail render in the root layout,
 * where `useNavigation()` is the container, so walk up to the root navigator.
 */
export function rootStackState(navigation: RootStackNavigation) {
  let root = navigation;
  for (let parent = root.getParent(); parent; parent = root.getParent()) root = parent;
  return root.getRootState?.() ?? root.getState();
}

/**
 * Replaces the root stack. Targets the root explicitly: a container dispatch runs on the deepest
 * focused navigator, which can be a nested stack that rejects the reset.
 */
export function dispatchRootStackReset(
  navigation: RootStackNavigation,
  state: NavigationState,
  payload: RootStackResetAction["payload"],
) {
  // Same shape as `CommonActions.reset`, which would pull React Native into node tests.
  navigation.dispatch({ type: "RESET", payload, target: state.key });
}

/** True when a tab flip would rebuild the same root routes — skip RESET and only change tab state. */
export function rootStackRoutesUnchanged(
  current: NavigationState,
  next: {
    readonly index: number;
    readonly routes: readonly { readonly key?: string; readonly name: string }[];
  },
) {
  if (current.index !== next.index || current.routes.length !== next.routes.length) return false;
  return current.routes.every((route, i) => {
    const other = next.routes[i];
    return other !== undefined && route.key === other.key && route.name === other.name;
  });
}

export function resetRootStack(
  navigation: RootStackNavigation,
  nextState: (state: NavigationState) => RootStackResetAction["payload"],
) {
  const state = rootStackState(navigation);
  if (state) dispatchRootStackReset(navigation, state, nextState(state));
}
