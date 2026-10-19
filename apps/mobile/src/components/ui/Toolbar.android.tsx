import { NativeHeaderToolbar } from "../../native/NativeHeaderToolbar";
import { NativeThemeHost } from "./NativeThemeHost.android";
import { HorizontalFloatingToolbar, RNHostView } from "@expo/ui/jetpack-compose";
import type { ToolbarProps } from "./Toolbar.types";

import { useControlTheme } from "./useControlTheme";

/** Native toolbar surface; hosted RN controls retain their existing menus and accessibility. */
function ToolbarRoot(props: ToolbarProps) {
  const { colors } = useControlTheme();
  if (props.placement) return <NativeHeaderToolbar {...props} />;
  return (
    <NativeThemeHost
      matchContents
      ignoreSafeAreaKeyboardInsets
      style={{ alignSelf: "center", maxWidth: "100%" }}
    >
      <HorizontalFloatingToolbar
        colors={{
          toolbarContainerColor: colors["--color-grouped-card"],
          toolbarContentColor: colors["--color-foreground"],
        }}
      >
        <RNHostView matchContents>{props.children}</RNHostView>
      </HorizontalFloatingToolbar>
    </NativeThemeHost>
  );
}

export const Toolbar = Object.assign(ToolbarRoot, {
  Button: NativeHeaderToolbar.Button,
  Custom: NativeHeaderToolbar.Custom,
  Label: NativeHeaderToolbar.Label,
  Menu: NativeHeaderToolbar.Menu,
  MenuAction: NativeHeaderToolbar.MenuAction,
  SearchBarSlot: NativeHeaderToolbar.SearchBarSlot,
  Spacer: NativeHeaderToolbar.Spacer,
});
