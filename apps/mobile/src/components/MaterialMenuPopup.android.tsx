import {
  Box,
  Column,
  DropdownMenu,
  DropdownMenuItem,
  Host,
  RNHostView,
  Text,
} from "@expo/ui/jetpack-compose";
import { padding, size, width } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { MaterialMenuPopupProps } from "./MaterialMenuPopup";
import { isAppSymbolName, SymbolView, type AppSymbolName } from "./AppSymbol";

function MenuIcon(props: {
  readonly name: AppSymbolName;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <RNHostView matchContents modifiers={[size(24, 24)]}>
      <View style={{ width: 24, height: 24 }} importantForAccessibility="no-hide-descendants">
        <SymbolView
          name={props.name}
          size={24}
          type="monochrome"
          tintColorClassName={
            props.disabled
              ? "accent-icon-subtle"
              : props.destructive
                ? "accent-danger-foreground"
                : "accent-foreground"
          }
        />
      </View>
    </RNHostView>
  );
}

/** Native popup positioned at the original trigger, outside virtualized rows. */
export function MaterialMenuPopup(props: MaterialMenuPopupProps) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const foreground = colors["--color-foreground"];
  const muted = colors["--color-foreground-muted"];
  const items = (
    <>
      {props.parent ? (
        <DropdownMenuItem onClick={props.onBack} modifiers={[width(250)]}>
          <DropdownMenuItem.LeadingIcon>
            <MenuIcon name="arrow.left" />
          </DropdownMenuItem.LeadingIcon>
          <DropdownMenuItem.Text>
            <Text color={foreground} style={{ typography: "bodyLarge" }}>
              {props.parent.title}
            </Text>
          </DropdownMenuItem.Text>
        </DropdownMenuItem>
      ) : props.title ? (
        <Text color={muted} style={{ typography: "bodySmall" }} modifiers={[padding(16, 8, 16, 8)]}>
          {props.title}
        </Text>
      ) : null}
      {props.actions.map((action, index) => (
        <DropdownMenuItem
          key={action.id ?? `${index}-${action.title}`}
          enabled={!action.attributes?.disabled}
          modifiers={[width(250)]}
          elementColors={{
            textColor: action.attributes?.destructive
              ? colors["--color-danger-foreground"]
              : foreground,
            disabledTextColor: muted,
          }}
          onClick={() => props.onPress(action)}
        >
          <DropdownMenuItem.Text>
            <Column>
              <Text
                style={{ typography: "bodyLarge" }}
                color={
                  action.attributes?.disabled
                    ? muted
                    : action.attributes?.destructive
                      ? colors["--color-danger-foreground"]
                      : foreground
                }
              >
                {action.title}
              </Text>
              {action.subtitle ? (
                <Text color={muted} style={{ typography: "bodySmall" }}>
                  {action.subtitle}
                </Text>
              ) : null}
            </Column>
          </DropdownMenuItem.Text>
          {action.image && isAppSymbolName(action.image) ? (
            <DropdownMenuItem.LeadingIcon>
              <MenuIcon
                name={action.image}
                destructive={action.attributes?.destructive}
                disabled={action.attributes?.disabled}
              />
            </DropdownMenuItem.LeadingIcon>
          ) : null}
          {(action.subactions?.length ?? 0) > 0 ? (
            <DropdownMenuItem.TrailingIcon>
              <MenuIcon name="chevron.right" disabled={action.attributes?.disabled} />
            </DropdownMenuItem.TrailingIcon>
          ) : action.state === "on" ? (
            <DropdownMenuItem.TrailingIcon>
              <MenuIcon name="checkmark" disabled={action.attributes?.disabled} />
            </DropdownMenuItem.TrailingIcon>
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  );
  if (props.inline) {
    return (
      <Host
        colorScheme={themeAppearance}
        ignoreSafeAreaKeyboardInsets
        matchContents
        style={{ width: 250 }}
      >
        <Column>{items}</Column>
      </Host>
    );
  }
  return (
    <Host
      colorScheme={themeAppearance}
      ignoreSafeAreaKeyboardInsets
      style={{
        position: "absolute",
        left: props.anchor.x,
        top: props.anchor.y,
        width: props.anchor.width,
        height: props.anchor.height,
      }}
    >
      <DropdownMenu expanded onDismissRequest={props.onClose} color={colors["--color-card-alt"]}>
        <DropdownMenu.Trigger>
          <Box modifiers={[size(props.anchor.width, props.anchor.height)]} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>{items}</DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  );
}
