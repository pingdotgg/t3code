import { RNHostView, TopAppBar } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, height } from "@expo/ui/jetpack-compose/modifiers";
import type { ReactElement } from "react";
import { NativeThemeHost } from "./NativeThemeHost.android";
import { useControlTheme } from "./useControlTheme";
import { useToolbarLayout } from "./useToolbarLayout";

/** Internal renderer. The surrounding screen owns status-bar and sheet insets. */
export function NativeAppBar(props: {
  readonly title: ReactElement;
  readonly navigationIcon?: ReactElement;
  readonly actions?: ReactElement;
  /** Shorter bar for a one-row title. */
  readonly singleLine?: boolean;
}) {
  const { colors } = useControlTheme();
  const layout = useToolbarLayout(false, props.singleLine);
  return (
    // The bar's height is fixed, so React Native lays out the screen below it from the first frame
    // instead of at zero height until Compose has measured and reported the bar.
    <NativeThemeHost style={{ width: "100%", height: layout.height }}>
      <TopAppBar
        applyWindowInsets={false}
        // Every header shares the list toolbar's height, so titles line up across panes.
        modifiers={[fillMaxWidth(), height(layout.height)]}
        colors={{
          containerColor: colors["--color-header"],
          titleContentColor: colors["--color-header-foreground"],
          navigationIconContentColor: colors["--color-header-foreground"],
          actionIconContentColor: colors["--color-header-foreground"],
        }}
      >
        <TopAppBar.Title>{props.title}</TopAppBar.Title>
        {props.navigationIcon ? (
          <TopAppBar.NavigationIcon>
            <RNHostView matchContents>{props.navigationIcon}</RNHostView>
          </TopAppBar.NavigationIcon>
        ) : null}
        {props.actions ? (
          <TopAppBar.Actions>
            <RNHostView matchContents>{props.actions}</RNHostView>
          </TopAppBar.Actions>
        ) : null}
      </TopAppBar>
    </NativeThemeHost>
  );
}
