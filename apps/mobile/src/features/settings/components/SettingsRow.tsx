import { useNavigation } from "@react-navigation/native";
import { use, type ComponentProps } from "react";
import { Platform } from "react-native";

import { ListRow } from "../../../components/ui/ListRow";
import type { SettingsLegalDocumentTarget, SettingsSheetTarget } from "./settings-sheet-targets";
import { SettingsPaneContext } from "../settings-pane-context";

export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof ListRow>["icon"];
  readonly label: string;
  readonly value?: string;
  readonly valuePosition?: "below" | "trailing";
  readonly target?: SettingsSheetTarget;
  readonly fullScreenTarget?: SettingsLegalDocumentTarget;
  readonly onPress?: () => void;
}) {
  const navigation = useNavigation();
  const pane = use(SettingsPaneContext);
  const valueBelow =
    props.valuePosition === "below" ||
    (props.valuePosition === undefined && Platform.OS === "android");
  return (
    <ListRow
      icon={props.icon}
      label={props.label}
      description={valueBelow ? props.value : undefined}
      detail={valueBelow ? undefined : props.value}
      disabled={props.disabled}
      selected={Boolean(props.target && pane?.selectedSection === props.target)}
      onPress={() => {
        if (props.target) {
          if (pane?.selectSection) {
            pane.selectSection(props.target);
            return;
          }
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: props.target },
          });
        } else if (props.fullScreenTarget) {
          navigation.navigate(props.fullScreenTarget);
        } else {
          props.onPress?.();
        }
      }}
    />
  );
}
