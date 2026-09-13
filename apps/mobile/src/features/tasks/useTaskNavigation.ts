import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { resolveTaskNavigation, type TaskNavigationIntent } from "./taskNavigation";

export function useTaskNavigation(task: EnvironmentTask) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const { layout } = useAdaptiveWorkspaceLayout();
  return (intent: TaskNavigationIntent) => {
    const state = navigation.getState();
    const target = resolveTaskNavigation({
      task,
      intent,
      usesSplitView: layout.usesSplitView,
      currentRouteName: state.routes[state.index]?.name,
    });
    if (!target) return;
    if (target.screen === "NewTaskSheet") navigation.navigate(target.screen, target.params);
    else if (target.action === "push") navigation.push(target.screen, target.params);
    else if (target.action === "set-params") navigation.setParams(target.params);
    else navigation.replace(target.screen, target.params);
  };
}
