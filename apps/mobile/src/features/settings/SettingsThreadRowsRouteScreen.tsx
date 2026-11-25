import { useAtomValue } from "@effect/atom-react";
import {
  MOBILE_DEFAULT_STORED_LAYOUT,
  SIDEBAR_ROW_ITEMS,
  SIDEBAR_ROW_ITEM_FORMS,
  findSidebarRowToken,
  isDefaultSidebarRowLayout,
  moveSidebarRowToken,
  resolveSidebarRowLayout,
  setSidebarRowLineKept,
  setSidebarRowTokenForm,
  storedSidebarRowLayout,
  type SidebarRowLayout,
  type SidebarRowLine,
} from "@t3tools/client-runtime/thread-row-layout";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages } from "gt-react-native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const LINES = ["top", "middle", "bottom", "hidden"] as const;

/** Every item of the layout in its line order, the title first so it is easy to find. */
function itemsInOrder(layout: SidebarRowLayout) {
  return LINES.flatMap((line) => layout[line].filter((token) => token.id !== "spacer"));
}

export function SettingsThreadRowsRouteScreen() {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const save = useAtomCommand(saveMobilePreferences);
  const layout = resolveSidebarRowLayout(
    AsyncResult.isSuccess(preferences) ? (preferences.value.threadRowLayout ?? {}) : {},
    MOBILE_DEFAULT_STORED_LAYOUT,
  );
  // Each edit reads the newest saved layout, so quick taps never undo one another.
  const edit = (change: (current: SidebarRowLayout) => SidebarRowLayout) => {
    void save({
      transform: (current) => ({
        threadRowLayout: storedSidebarRowLayout(
          change(
            resolveSidebarRowLayout(current.threadRowLayout ?? {}, MOBILE_DEFAULT_STORED_LAYOUT),
          ),
          MOBILE_DEFAULT_STORED_LAYOUT,
        ),
      }),
    });
  };
  const lineLabels: Record<SidebarRowLine, string> = {
    top: gt("Top", { $context: "thread row line" }),
    middle: gt("Middle", { $context: "thread row line" }),
    bottom: gt("Bottom", { $context: "thread row line" }),
    hidden: gt("Hidden", { $context: "thread row item that is not shown" }),
  };
  const fixed = layout.keepLines.length > 0;

  return (
    <SettingsScreen title={gt("Thread rows")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <Text className="px-2 text-sm text-foreground-muted">
          {gt(
            "Choose what each thread in the list shows, and on which line. Saved on this device.",
          )}
        </Text>
        <SettingsSection title={gt("Height")}>
          {[false, true].map((value, index) => (
            <ListChoiceRow
              key={String(value)}
              label={value ? gt("Same for every thread") : gt("Fit content")}
              description={
                value
                  ? gt("Lines stay even when a thread has nothing for them.")
                  : gt("A line with nothing to show folds away.")
              }
              selected={fixed === value}
              separated={index > 0}
              disabled={!ready}
              onPress={() =>
                edit((current) =>
                  setSidebarRowLineKept(
                    setSidebarRowLineKept(current, "middle", value),
                    "bottom",
                    value,
                  ),
                )
              }
            />
          ))}
        </SettingsSection>
        <SettingsSection title={gt("Items")}>
          {itemsInOrder(layout).map((token, index) => {
            const found = findSidebarRowToken(layout, token.key);
            if (!found) return null;
            const label = m(
              SIDEBAR_ROW_ITEMS.find((item) => item.id === token.id)?.label ??
                SIDEBAR_ROW_ITEMS[0].label,
            );
            const lineLength = layout[found.line].length;
            const forms = SIDEBAR_ROW_ITEM_FORMS[token.id];
            const lineOptions = LINES.filter((line) => token.id !== "title" || line !== "hidden");
            return (
              <View
                key={token.key}
                className={
                  index > 0 ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
                }
              >
                <View className="flex-row items-center gap-2">
                  <Text
                    className={found.line === "hidden" ? "flex-1 text-foreground-muted" : "flex-1"}
                  >
                    {label}
                  </Text>
                  <IconButton
                    icon="arrow.up"
                    accessibilityLabel={gt("Move {item} earlier", { item: label })}
                    disabled={!ready || found.line === "hidden" || found.index === 0}
                    onPress={() =>
                      edit((current) =>
                        moveSidebarRowToken(current, token.key, found.line, found.index - 1),
                      )
                    }
                  />
                  <IconButton
                    icon="arrow.down"
                    accessibilityLabel={gt("Move {item} later", { item: label })}
                    disabled={!ready || found.line === "hidden" || found.index === lineLength - 1}
                    onPress={() =>
                      edit((current) =>
                        moveSidebarRowToken(current, token.key, found.line, found.index + 1),
                      )
                    }
                  />
                </View>
                <SegmentedControl
                  size="compact"
                  variant="card"
                  options={lineOptions.map((line) => ({ value: line, label: lineLabels[line] }))}
                  selected={found.line}
                  onSelect={(line) => {
                    if (!ready || line === found.line) return;
                    edit((current) =>
                      moveSidebarRowToken(current, token.key, line, Number.POSITIVE_INFINITY),
                    );
                  }}
                />
                {forms && found.line !== "hidden" ? (
                  <SegmentedControl
                    size="compact"
                    variant="card"
                    options={forms.map((form) => ({
                      value: form,
                      label:
                        form === "wide"
                          ? gt("Wide", { $context: "icon and name" })
                          : gt("Compact", { $context: "icon only" }),
                    }))}
                    selected={token.form ?? forms[0]!}
                    onSelect={(form) => {
                      if (ready)
                        edit((current) => setSidebarRowTokenForm(current, token.key, form));
                    }}
                  />
                ) : null}
              </View>
            );
          })}
        </SettingsSection>
        <Button
          label={gt("Reset to default")}
          tone="text"
          disabled={!ready || isDefaultSidebarRowLayout(layout, MOBILE_DEFAULT_STORED_LAYOUT)}
          onPress={() => {
            void save({ threadRowLayout: {} });
          }}
        />
      </ScreenScrollView>
    </SettingsScreen>
  );
}
