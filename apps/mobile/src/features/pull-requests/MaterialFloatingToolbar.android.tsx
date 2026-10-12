import { HorizontalFloatingToolbar, Host, RNHostView } from "@expo/ui/jetpack-compose";
import type { ReactElement } from "react";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** Native toolbar surface; hosted RN controls retain their existing menus and accessibility. */
export function MaterialFloatingToolbar(props: { readonly children: ReactElement }) {
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  return (
    <Host
      matchContents
      colorScheme={themeAppearance}
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
    </Host>
  );
}
