import { NativeAppBarExample } from "./NativeAppBarExample";
import { Toast } from "../../components/ui/Toast";
import { Progress } from "../../components/ui/Progress";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { View, type TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { Chip } from "../../components/ui/Chip";
import { Menu } from "../../components/ui/Menu";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { FloatingActionButton } from "../../components/ui/FloatingActionButton";
import { SearchField } from "../../components/ui/SearchField";
import { Notice } from "../../components/ui/Notice";
import { NumberField } from "../../components/ui/NumberField";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SliderRow } from "../../components/ui/SliderRow";
import * as Dialog from "../../components/ui/Dialog";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { MOBILE_THEME_IDS } from "../../lib/mobileTheme";

const CHOICES = [
  { value: "overview", label: "Overview" },
  { value: "activity", label: "Activity" },
];

export function ComponentCatalogScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const appearance = useAppearancePreferences();
  const [page, setPage] = useState("controls");
  const [tab, setTab] = useState("overview");
  const [enabled, setEnabled] = useState(true);
  const [value, setValue] = useState(3);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [sheet, setSheet] = useState(false);
  const [notice, setNotice] = useState(true);
  const searchRef = useRef<TextInputInstance>(null);
  const announceAction = () => setNotice(true);
  const confirm = () => {
    Dialog.confirm({
      title: "Discard changes?",
      message: "This example only changes local catalog state.",
      confirmText: "Discard",
      destructive: true,
      onConfirm: () => setText(""),
    });
  };
  return (
    <View className="flex-1 bg-screen">
      <AppBar title="UI components" onBack={() => navigation.goBack()} sidebar={false} />
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-3">
          <AppText className="text-sm text-foreground-muted">Theme preview</AppText>
          <View className="flex-row flex-wrap gap-2">
            {MOBILE_THEME_IDS.filter(
              (id) => id !== "material-you" || appearance.systemColorsAvailable,
            ).map((id) => (
              <Chip
                key={id}
                label={id}
                selected={appearance.themeId === id}
                onPress={() => appearance.setThemeIdForBothAppearances(id)}
              />
            ))}
          </View>
          <SegmentedControl
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            selected={appearance.themeAppearance}
            onSelect={appearance.setThemeMode}
            size="compact"
          />
        </View>
        <SegmentedControl
          options={[
            { value: "controls", label: "Controls" },
            { value: "forms", label: "Forms" },
            { value: "feedback", label: "Feedback" },
          ]}
          selected={page}
          onSelect={setPage}
          size="compact"
        />
        {page === "controls" ? (
          <>
            <View className="gap-3">
              <AppText className="text-lg font-t3-semibold">Lists and selection</AppText>
              <ListSection>
                <View className="p-4">
                  <SegmentedControl
                    variant="card"
                    options={CHOICES}
                    selected={tab}
                    onSelect={setTab}
                    size="compact"
                    role="tab"
                  />
                </View>
                <ListRow icon="folder" label="Projects" detail="4" onPress={() => setSheet(true)} />
                <ListToggleRow
                  icon="bell.badge"
                  label="Notifications"
                  description="Updates from your active threads"
                  value={enabled}
                  onValueChange={setEnabled}
                />
                <ListChoiceRow label="Selected option" selected onPress={announceAction} />
                <ListActionRow
                  icon="trash"
                  label="Discard changes"
                  tone="danger"
                  onPress={confirm}
                />
              </ListSection>
              <SegmentedControl
                options={CHOICES}
                selected={tab}
                onSelect={setTab}
                size="compact"
                role="tab"
              />
              <View className="flex-row flex-wrap gap-2">
                <Chip
                  label="Selected filter"
                  selected={enabled}
                  onPress={() => setEnabled(!enabled)}
                />
                <Chip label="Label" size="small" />
                <Chip label="Disabled" disabled onPress={announceAction} />
              </View>
            </View>
            <View className="gap-3">
              <NativeAppBarExample />
              <AppText className="text-lg font-t3-semibold">Buttons</AppText>
              <View className="flex-row flex-wrap gap-2">
                <Button label="Primary" tone="primary" onPress={announceAction} />
                <Button label="Secondary" onPress={announceAction} />
                <Button label="Contrast" tone="contrast" onPress={announceAction} />
              </View>
              <View className="flex-row flex-wrap gap-2">
                <Button label="Disabled" disabled onPress={announceAction} />
                <Button label="Loading" loading onPress={announceAction} />
                <IconButton
                  accessibilityLabel="Open example sheet"
                  icon="plus"
                  variant="tonal"
                  onPress={() => setSheet(true)}
                />
              </View>
            </View>
          </>
        ) : null}
        {page === "forms" ? (
          <View className="gap-3">
            <AppText className="text-lg font-t3-semibold">Forms</AppText>
            <AppTextInput
              accessibilityLabel="Example name"
              placeholder="Name"
              value={text}
              onChangeText={setText}
            />
            <View className="flex-row">
              <SearchField
                inputRef={searchRef}
                accessibilityLabel="Search examples"
                clearAccessibilityLabel="Clear examples search"
                placeholder="Search examples"
                value={search}
                onChangeText={setSearch}
                autoFocus={false}
              />
            </View>
            <View className="flex-row items-center justify-between">
              <AppText>Count</AppText>
              <NumberField
                label="Example count"
                min={1}
                max={10}
                value={value}
                onValueChange={setValue}
              />
            </View>
            <ListSection>
              <SliderRow
                icon="textformat.size"
                label="Example slider"
                valueLabel={String(value)}
                min={1}
                max={10}
                step={1}
                value={value}
                onChange={setValue}
              />
            </ListSection>
          </View>
        ) : null}
        {page === "feedback" ? (
          <View className="gap-3">
            <AppText className="text-lg font-t3-semibold">Feedback and presentation</AppText>
            <Notice message="This action could not finish. Try again." tone="danger" />
            <Button label="Show notice" onPress={announceAction} />
            <View className="flex-row flex-wrap gap-2">
              <Button label="Sheet" onPress={() => setSheet(true)} />
              <Button label="Dialog" onPress={confirm} />
              <Button
                label="Alert"
                onPress={() =>
                  Dialog.alert("Example alert", "Choose an action.", [
                    {
                      text: "More info",
                      onPress: () =>
                        Dialog.alert("More information", "This second alert stays open."),
                    },
                    { text: "Cancel", style: "cancel" },
                    { text: "Continue", onPress: announceAction },
                  ])
                }
              />
              <Button
                label="Prompt"
                onPress={() =>
                  Dialog.prompt({
                    title: "Rename example",
                    initialValue: text,
                    confirmText: "Rename",
                    onConfirm: setText,
                  })
                }
              />
              <Menu
                title="Example menu"
                actions={[
                  { id: "copy", title: "Copy", image: "doc.on.doc" },
                  { id: "discard", title: "Discard", attributes: { destructive: true } },
                ]}
                onPressAction={({ nativeEvent }) =>
                  nativeEvent.event === "discard" ? confirm() : announceAction()
                }
              >
                <Chip label="Menu" trailingIcon="chevron.down" />
              </Menu>
            </View>
            <Progress value={0.6} label="Example upload" />
            <Progress label="Connecting" />
            <View className="items-start">
              <FloatingActionButton
                label="New thread"
                icon="plus"
                variant="extended"
                tone="primary"
                onPress={() => setSheet(true)}
              />
            </View>
          </View>
        ) : null}
      </ScreenScrollView>
      {page === "feedback" && notice ? (
        <View
          collapsable={false}
          className="absolute inset-x-3 z-[100]"
          style={{ bottom: insets.bottom + 12 }}
          pointerEvents="box-none"
        >
          <Toast
            message="Changes are ready to review."
            tone="success"
            dismissMode="swipe"
            action={{
              label: "Undo",
              onPress: () => {
                setNotice(false);
                setText("Restored example");
              },
            }}
            onDismiss={() => setNotice(false)}
          />
        </View>
      ) : null}
      {sheet ? (
        <Sheet title="Example sheet" onClose={() => setSheet(false)}>
          <ScreenScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="p-4"
          >
            <ListSection>
              <ListChoiceRow
                label="Overview"
                selected={tab === "overview"}
                onPress={() => setTab("overview")}
              />
              <ListChoiceRow
                label="Activity"
                selected={tab === "activity"}
                onPress={() => setTab("activity")}
              />
            </ListSection>
          </ScreenScrollView>
        </Sheet>
      ) : null}
    </View>
  );
}
