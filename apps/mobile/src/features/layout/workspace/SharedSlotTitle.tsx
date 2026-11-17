import { Platform, Pressable } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Menu } from "../../../components/ui/Menu";
import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import { isSharedSlotTab, type SharedSlotTab } from "./navigation-tab-order";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

const TITLES = { pullRequests: "Pull requests", issues: "Issues" } as const;

/** The header title of the tab pull requests and issues share: names the list and switches it. */
export function SharedSlotTitle(props: { readonly tab: SharedSlotTab }) {
  const selectTab = useSelectWorkspaceTab();
  const { scale } = useAndroidControlSizing();
  return (
    <Menu
      actions={Object.entries(TITLES).map(([id, title]) => ({
        id,
        title,
        state: id === props.tab ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (isSharedSlotTab(id) && id !== props.tab) selectTab(id);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${TITLES[props.tab]}, switch list`}
        hitSlop={8}
        className="flex-row items-center gap-1.5"
      >
        <Text
          allowFontScaling={Platform.OS === "ios"}
          maxFontSizeMultiplier={1.4}
          numberOfLines={1}
          className="font-t3-bold text-foreground"
          style={{ fontSize: 20 * scale, letterSpacing: -0.4 * scale }}
        >
          {TITLES[props.tab]}
        </Text>
        <SymbolView
          name="chevron.down"
          size={Math.round(12 * scale)}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
    </Menu>
  );
}
