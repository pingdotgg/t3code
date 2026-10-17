import { CommonActions, StackActions, type NavigationState } from "@react-navigation/native";
import { androidWorkspaceNavigationState } from "../../lib/android-workspace-navigation";

/** Called after the task is saved, against the stack that owns the draft sheet. */
export function newTaskSubmitNavigationAction(input: {
  readonly state: NavigationState;
  readonly params: ReactNavigation.RootParamList["Thread"];
  readonly queued: boolean;
  readonly android: boolean;
}) {
  if (input.queued) return CommonActions.goBack();
  if (input.android)
    return CommonActions.reset(
      androidWorkspaceNavigationState(input.state, { name: "Thread", params: input.params }),
    );
  return StackActions.replace("Thread", input.params);
}
