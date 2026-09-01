import type { NavigationState, PartialState } from "@react-navigation/native";

type RememberedNavigationState = NavigationState | PartialState<NavigationState>;

let rememberedNavigationState: RememberedNavigationState | undefined;

export function rememberNavigationState(state: Readonly<NavigationState> | undefined): void {
  rememberedNavigationState = state;
}

export function readRememberedNavigationState(): RememberedNavigationState | undefined {
  return rememberedNavigationState;
}

export function resetRememberedNavigationStateForTests(): void {
  rememberedNavigationState = undefined;
}
