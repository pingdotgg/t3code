import { useNavigation } from "@react-navigation/native";
import { useRef, useState } from "react";
import { Alert, Platform, View, type TextInputInstance } from "react-native";

import { AppText, AppTextInput } from "../../components/AppText";
import { AppSheet } from "../../components/AppSheet";
import { Chip } from "../../components/Chip";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { ListActionRow } from "../../components/ListActionRow";
import { ListChoiceRow } from "../../components/ListChoiceRow";
import { ListRow } from "../../components/ListRow";
import { ListSection } from "../../components/ListSection";
import { ListToggleRow } from "../../components/ListToggleRow";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import { SearchField } from "../../components/SearchField";
import { LoadingStrip } from "../../components/LoadingStrip";
import { Notice } from "../../components/Notice";
import { NumberField } from "../../components/NumberField";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { SliderRow } from "../../components/SliderRow";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { MOBILE_THEME_IDS } from "../../lib/mobileTheme";

const CHOICES = [
  { value: "overview", label: "Overview" },
  { value: "activity", label: "Activity" },
];

/** Development-only, real controls with local state and no environment commands. */
export function ComponentCatalogScreen() {
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
    if (Platform.OS === "ios")
      Alert.alert("Discard changes?", "This example only changes local catalog state.", [
        { text: "Cancel", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => setText("") },
      ]);
    else
      showConfirmDialog({
        title: "Discard changes?",
        message: "This example only changes local catalog state.",
        confirmText: "Discard",
        destructive: true,
        onConfirm: () => setText(""),
      });
  };
  return (
    <View className="flex-1 bg-screen">
      <ScreenHeader title="UI components" onBack={() => navigation.goBack()} sidebar={false} />
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
            {notice ? (
              <Notice
                message="Changes are ready to review."
                icon="checkmark.circle"
                floating
                onDismiss={() => setNotice(false)}
              />
            ) : (
              <Button label="Show notice" onPress={announceAction} />
            )}
            <View className="flex-row flex-wrap gap-2">
              <Button label="Sheet" onPress={() => setSheet(true)} />
              <Button label="Dialog" onPress={confirm} />
              <ControlPillMenu
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
              </ControlPillMenu>
            </View>
            <View className="relative h-3 overflow-hidden rounded-full bg-subtle">
              <LoadingStrip progress={0.6} />
            </View>
            <View className="items-start">
              <MaterialFloatingActionButton
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
      {sheet ? (
        <AppSheet title="Example sheet" onClose={() => setSheet(false)}>
          <View className="p-4">
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
          </View>
        </AppSheet>
      ) : null}
    </View>
  );
}
