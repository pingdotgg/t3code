import {
  Badge,
  Row,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Text,
} from "@expo/ui/jetpack-compose";
import { defaultMinSize, fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import type { SegmentedControlProps } from "./SegmentedControl.types";

/** Compose content shared by screen controls and native dialogs, inside their existing Host. */
export function MaterialSegmentedButtons<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  const { themeVariables: colors } = useAppearancePreferences();
  const typography = useScaledTextRole("footnote");
  return (
    <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
      {props.options.map((option) => (
        <SegmentedButton
          key={String(option.value)}
          selected={option.value === props.selected}
          onClick={() => props.onSelect(option.value)}
          modifiers={[defaultMinSize({ minHeight: 48 })]}
          colors={{
            activeContainerColor: colors["--color-secondary"],
            activeContentColor: colors["--color-secondary-foreground"],
            inactiveContainerColor: "transparent",
            inactiveContentColor: colors["--color-foreground"],
            activeBorderColor: colors["--color-border"],
            inactiveBorderColor: colors["--color-border"],
          }}
        >
          <SegmentedButton.Label>
            <Row horizontalArrangement={{ spacedBy: 6 }} verticalAlignment="center">
              <Text style={typography}>{option.label}</Text>
              {option.badge !== undefined ? (
                <Badge
                  containerColor={colors["--color-secondary"]}
                  contentColor={colors["--color-primary-text"]}
                >
                  <Text>{String(option.badge)}</Text>
                </Badge>
              ) : null}
            </Row>
          </SegmentedButton.Label>
        </SegmentedButton>
      ))}
    </SingleChoiceSegmentedButtonRow>
  );
}
