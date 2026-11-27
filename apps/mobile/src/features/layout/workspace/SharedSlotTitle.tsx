import { useNavigation } from "@react-navigation/native";
import { queuePickerOpenAtom, queuePickerVisibleAtom } from "../../../state/mergeQueueSelection";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { mobileMergeQueuesEnabledAtom } from "../../../state/preferences";
import { msg, useGT, useMessages } from "gt-react-native";
import { Platform, Pressable } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Menu } from "../../../components/ui/Menu";
import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import { isSharedSlotTab, type SharedSlotTab } from "./navigation-tab-order";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

const TITLES = {
  pullRequests: msg("Pull requests"),
  issues: msg("Issues", { $context: "screen title, list of issues" }),
} as const;

/** The header title of the tab pull requests and issues share: names the list and switches it. */
export function SharedSlotTitle(props: { readonly tab: SharedSlotTab }) {
  const navigation = useNavigation();
  const queuesEnabled = useAtomValue(mobileMergeQueuesEnabledAtom);
  const { layout } = useAdaptiveWorkspaceLayout();
  const split = Platform.OS === "ios" && layout.usesSplitView;
  const setPicker = useAtomSet(queuePickerOpenAtom);
  const pickerOpen = useAtomValue(queuePickerVisibleAtom) && split;
  const gt = useGT();
  const messages = useMessages();
  const selectTab = useSelectWorkspaceTab();
  const { scale } = useAndroidControlSizing();
  const title = pickerOpen ? gt("Merge queues") : messages(TITLES[props.tab]);
  return (
    <Menu
      actions={[
        ...Object.entries(TITLES).map(([id, title]) => ({
          id,
          title: messages(title),
          state: !pickerOpen && id === props.tab ? ("on" as const) : ("off" as const),
        })),
        ...(queuesEnabled
          ? [
              {
                id: "mergeQueues",
                title: gt("Merge queues"),
                state: pickerOpen ? ("on" as const) : ("off" as const),
              },
            ]
          : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (id === "mergeQueues") {
          setPicker(split);
          if (split) navigation.navigate("MergeQueueEntries");
          else navigation.navigate("MergeQueues");
        } else if (isSharedSlotTab(id) && (pickerOpen || id !== props.tab)) {
          setPicker(false);
          selectTab(id);
        }
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("{list}, switch list", { list: title })}
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
          {title}
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
