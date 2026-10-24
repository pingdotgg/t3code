import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { linkedThreadStep } from "../../lib/android-workspace-navigation";

export function useOpenLinkedThread() {
  const navigation = useNavigation();
  return useCallback(
    (target: { readonly environmentId: string; readonly threadId: string }) => {
      const state = navigation.getState();
      const step = state ? linkedThreadStep(state, target) : "push";
      if (step === "pop") navigation.dispatch(StackActions.pop());
      else if (step === "push") navigation.dispatch(StackActions.push("Thread", target));
    },
    [navigation],
  );
}
