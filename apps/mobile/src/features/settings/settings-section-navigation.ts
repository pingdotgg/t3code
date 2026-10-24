import {
  CommonActions,
  StackActions,
  type ParamListBase,
  type StackNavigationState,
} from "@react-navigation/native";
import type { SettingsSheetTarget } from "./components/settings-sheet-targets";

export function settingsSectionNavigationAction(
  state: Pick<StackNavigationState<ParamListBase>, "key" | "routes">,
  target: SettingsSheetTarget,
) {
  const root = state.routes.find((route) => route.name === "Settings");
  if (!root) return null;
  return {
    ...(state.routes[1]?.name === target
      ? StackActions.popTo(target, undefined, { merge: true })
      : CommonActions.reset({
          stale: true,
          index: 1,
          routes: [
            { key: root.key, name: root.name, params: root.params, path: root.path },
            { name: target },
          ],
        })),
    target: state.key,
  };
}
