import { NativeThemeHost } from "./NativeThemeHost.android";
import {
  Box,
  Column,
  DropdownMenu,
  DropdownMenuItem,
  RNHostView,
  Text,
} from "@expo/ui/jetpack-compose";
import { defaultMinSize, padding, size, width } from "@expo/ui/jetpack-compose/modifiers";
import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";
import { resolveScaledTextRole } from "../../lib/appearancePreferences";

import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import type { MenuPopupProps } from "./MenuPopup";
import { isAppSymbolName, SymbolView, type AppSymbolName } from "./AppSymbol";

// The Compose glyph host consumes touches; run the action here and keep accessibility on the row.
function MenuIcon(props: {
  readonly name: AppSymbolName;
  readonly color?: MenuAction["imageColor"];
  readonly onPress: () => void;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}) {
  const { iconSize } = useAndroidControlSizing();
  return (
    <RNHostView matchContents modifiers={[size(iconSize, iconSize)]}>
      <Pressable
        accessible={false}
        focusable={false}
        disabled={props.disabled}
        onPress={props.onPress}
        style={{ width: iconSize, height: iconSize }}
        importantForAccessibility="no-hide-descendants"
      >
        <SymbolView
          name={props.name}
          size={iconSize}
          type="monochrome"
          {...(typeof props.color === "string" && !props.disabled
            ? { tintColor: props.color }
            : {
                tintColorClassName: props.disabled
                  ? "accent-icon-subtle"
                  : props.destructive
                    ? "accent-danger-foreground"
                    : "accent-foreground",
              })}
        />
      </Pressable>
    </RNHostView>
  );
}

export function MenuPopupItems(
  props: Pick<MenuPopupProps, "menuWidth" | "actions" | "title" | "parent" | "onPress" | "onBack">,
) {
  const { appearance, themeVariables: colors } = useAppearancePreferences();
  const { scale, menuItemHeight } = useAndroidControlSizing();
  const body = resolveScaledTextRole("body", appearance.baseFontSize);
  const caption = resolveScaledTextRole("caption", appearance.baseFontSize);
  const foreground = colors["--color-foreground"];
  const muted = colors["--color-foreground-muted"];
  // A fixed native item height clips wrapped labels; a minimum lets each row grow.
  const itemModifiers = [width(props.menuWidth), defaultMinSize({ minHeight: menuItemHeight })];
  return (
    <>
      {props.parent ? (
        <DropdownMenuItem onClick={props.onBack} modifiers={itemModifiers}>
          <DropdownMenuItem.LeadingIcon>
            <MenuIcon name="arrow.left" onPress={props.onBack} />
          </DropdownMenuItem.LeadingIcon>
          <DropdownMenuItem.Text>
            <Text color={foreground} style={{ typography: "bodyLarge", ...body }}>
              {props.parent.title}
            </Text>
          </DropdownMenuItem.Text>
        </DropdownMenuItem>
      ) : props.title ? (
        <Text
          color={muted}
          style={{ typography: "bodySmall", ...caption }}
          modifiers={[padding(16 * scale, 8 * scale, 16 * scale, 8 * scale)]}
        >
          {props.title}
        </Text>
      ) : null}
      {props.actions.map((action, index) => (
        <DropdownMenuItem
          key={action.id ?? `${index}-${action.title}`}
          enabled={!action.attributes?.disabled}
          modifiers={itemModifiers}
          onClick={() => props.onPress(action)}
        >
          {action.image && isAppSymbolName(action.image) ? (
            <DropdownMenuItem.LeadingIcon>
              <MenuIcon
                name={action.image}
                color={action.imageColor}
                onPress={() => props.onPress(action)}
                destructive={action.attributes?.destructive}
                disabled={action.attributes?.disabled}
              />
            </DropdownMenuItem.LeadingIcon>
          ) : null}
          <DropdownMenuItem.Text>
            <Column>
              <Text
                style={{ typography: "bodyLarge", ...body }}
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
                <Text color={muted} style={{ typography: "bodySmall", ...caption }}>
                  {action.subtitle}
                </Text>
              ) : null}
            </Column>
          </DropdownMenuItem.Text>
          {(action.subactions?.length ?? 0) > 0 ? (
            <DropdownMenuItem.TrailingIcon>
              <MenuIcon
                name="chevron.right"
                onPress={() => props.onPress(action)}
                disabled={action.attributes?.disabled}
              />
            </DropdownMenuItem.TrailingIcon>
          ) : action.state === "on" ? (
            <DropdownMenuItem.TrailingIcon>
              <MenuIcon
                name="checkmark"
                onPress={() => props.onPress(action)}
                disabled={action.attributes?.disabled}
              />
            </DropdownMenuItem.TrailingIcon>
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  );
}

export function MenuPopup(props: MenuPopupProps) {
  const { themeVariables: colors } = useAppearancePreferences();
  const items = <MenuPopupItems {...props} />;
  if (props.inline) {
    return (
      <NativeThemeHost
        ignoreSafeAreaKeyboardInsets
        matchContents
        style={{ width: props.menuWidth }}
      >
        <Column>{items}</Column>
      </NativeThemeHost>
    );
  }
  return (
    <NativeThemeHost
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
    </NativeThemeHost>
  );
}
