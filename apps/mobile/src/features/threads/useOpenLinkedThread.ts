import { StackActions, useNavigation, useRoute, type Route } from "@react-navigation/native";
import { use } from "react";
import { linkedThreadStep } from "../../lib/android-workspace-navigation";
import {
  ThreadInspectorNavigationContext,
  useOpenThreadInspector,
} from "./thread-inspector-navigation";

export function useOpenLinkedThread() {
  const navigation = useNavigation();
  const route = useRoute<Route<string, { environmentId?: string; threadId?: string }>>();
  const openInspector = useOpenThreadInspector();
  const openInInspector = use(ThreadInspectorNavigationContext);
  return (target: { readonly environmentId: string; readonly threadId: string }) => {
    if (openInInspector) {
      openInInspector({ type: "thread", ...target });
      return;
    }
    const state = navigation.getState();
    const step = state ? linkedThreadStep(state, target) : "push";
    if (
      step === "push" &&
      route.name === "Thread" &&
      route.params?.environmentId &&
      route.params.threadId &&
      openInspector(
        { environmentId: route.params.environmentId, threadId: route.params.threadId },
        { type: "thread", ...target },
      )
    )
      return;
    if (step === "pop") navigation.dispatch(StackActions.pop());
    else if (step === "push") navigation.dispatch(StackActions.push("Thread", target));
  };
}
