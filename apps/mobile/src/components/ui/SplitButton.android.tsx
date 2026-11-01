import {
  Box,
  DropdownMenu,
  Icon,
  LoadingIndicator,
  RNHostView,
  Row,
  SplitButtonLayout,
  Text,
} from "@expo/ui/jetpack-compose";
import {
  defaultMinSize,
  fillMaxWidth,
  rotate,
  semantics,
  size,
} from "@expo/ui/jetpack-compose/modifiers";
import { useState } from "react";
import { Pressable } from "react-native";

import { useScaledTextRole } from "../../features/settings/appearance/useScaledTextRole";
import { SymbolView } from "./AppSymbol";
import { Button } from "./Button";
import { MenuPopupItems } from "./MenuPopup.android";
import { NativeThemeHost } from "./NativeThemeHost.android";
import type { SplitButtonProps } from "./SplitButton.types";
import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { useControlTheme } from "./useControlTheme";

export function SplitButton(props: SplitButtonProps) {
  const { colors } = useControlTheme();
  const typography = useScaledTextRole("footnote");
  const { scale, iconSize, mediumIconSize, menuWidth } = useAndroidControlSizing();
  const [expanded, setExpanded] = useState(false);
  if (props.actions.length === 0) return <Button {...props} tone="primary" fullWidth />;
  const enabled = !props.disabled && !props.loading;
  const menuEnabled = props.actions.some((action) => !action.attributes?.disabled);
  const buttonColors = {
    containerColor: colors["--color-primary"],
    contentColor: colors["--color-primary-foreground"],
    disabledContainerColor: colors["--color-subtle-strong"],
    disabledContentColor: colors["--color-foreground-muted"],
  };
  // A usable menu beside a disabled action still takes the disabled palette, so the pair reads as one control.
  const trailingColors = enabled
    ? buttonColors
    : {
        ...buttonColors,
        containerColor: buttonColors.disabledContainerColor,
        contentColor: buttonColors.disabledContentColor,
      };
  const label = (
    <Row verticalAlignment="center">
      {props.loading ? (
        <>
          <LoadingIndicator
            modifiers={[size(mediumIconSize, mediumIconSize)]}
            color={colors["--color-foreground-muted"]}
          />
          <Box modifiers={[size(8 * scale, 1)]} />
        </>
      ) : props.icon ? (
        <>
          {/* The glyph host consumes touches, so it runs the action itself. */}
          <RNHostView matchContents modifiers={[size(mediumIconSize, mediumIconSize)]}>
            <Pressable
              accessible={false}
              disabled={!enabled}
              onPress={props.onPress}
              importantForAccessibility="no-hide-descendants"
              style={{ width: mediumIconSize, height: mediumIconSize }}
            >
              <SymbolView
                name={props.icon}
                size={mediumIconSize}
                tintColor={enabled ? buttonColors.contentColor : buttonColors.disabledContentColor}
              />
            </Pressable>
          </RNHostView>
          <Box modifiers={[size(8 * scale, 1)]} />
        </>
      ) : null}
      <Text style={{ ...typography, fontWeight: "500" }}>{props.label}</Text>
    </Row>
  );
  return (
    <NativeThemeHost
      matchContents={{ vertical: true }}
      ignoreSafeAreaKeyboardInsets
      style={{ width: "100%" }}
    >
      <SplitButtonLayout modifiers={[fillMaxWidth()]}>
        <SplitButtonLayout.LeadingButton
          enabled={enabled}
          onClick={props.onPress}
          colors={buttonColors}
          modifiers={[
            fillMaxWidth(),
            defaultMinSize({ minHeight: 48 }),
            semantics({ contentDescription: props.accessibilityLabel ?? props.label }),
          ]}
        >
          {label}
        </SplitButtonLayout.LeadingButton>
        <SplitButtonLayout.TrailingButton
          checked={expanded}
          onCheckedChange={setExpanded}
          enabled={menuEnabled}
          colors={trailingColors}
          modifiers={[
            defaultMinSize({ minWidth: 48, minHeight: 48 }),
            semantics({ contentDescription: props.menuTitle }),
          ]}
        >
          <DropdownMenu
            expanded={expanded && menuEnabled}
            onDismissRequest={() => setExpanded(false)}
            color={colors["--color-card-alt"]}
          >
            <DropdownMenu.Trigger>
              <Icon
                source={require("../../../assets/icons/chevron-down.xml")}
                size={iconSize}
                modifiers={[rotate(expanded ? 180 : 0)]}
              />
            </DropdownMenu.Trigger>
            <DropdownMenu.Items>
              <MenuPopupItems
                menuWidth={menuWidth}
                actions={props.actions}
                title={props.menuTitle}
                parent={null}
                onPress={(action) => {
                  setExpanded(false);
                  if (action.id !== undefined) props.onPressAction(action.id);
                }}
                onBack={() => {}}
              />
            </DropdownMenu.Items>
          </DropdownMenu>
        </SplitButtonLayout.TrailingButton>
      </SplitButtonLayout>
    </NativeThemeHost>
  );
}
