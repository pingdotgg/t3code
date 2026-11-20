import { useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Progress } from "../../components/ui/Progress";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import type { ModelDownloadState } from "./dictationDownloads";

export function DictationSettingsPage(props: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={props.title}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {props.children}
      </ScrollView>
    </SettingsScreen>
  );
}

/** Shown where the native dictation module is not in the build, such as on Android. */
export function DictationUnavailable(props: { readonly title: string }) {
  const gt = useGT();
  return (
    <DictationSettingsPage title={props.title}>
      <SettingsSection>
        <ListRowLayout icon="mic" label={gt("Not available on this device")} />
      </SettingsSection>
    </DictationSettingsPage>
  );
}

export function Footnote(props: { readonly children: ReactNode }) {
  return <Text className="px-2 text-sm text-foreground-muted">{props.children}</Text>;
}

/** A model that is not on the device: a download button, or the download's progress. */
export function DownloadRow(props: {
  readonly name: string;
  readonly description: string;
  readonly state: ModelDownloadState;
  readonly onDownload: () => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const { progress, error } = props.state;
  return (
    <View>
      {progress === null ? (
        <ListActionRow
          icon="arrow.down.circle"
          label={gt("Download {name}", { name: props.name })}
          description={props.description}
          onPress={props.onDownload}
        />
      ) : (
        <>
          <ListRowLayout
            icon="arrow.down.circle"
            label={props.name}
            description={
              progress.phase === "preparing"
                ? gt("Getting the model ready. This can take a minute.")
                : gt("Downloading, {value}%", { value: Math.round(progress.fraction * 100) })
            }
            accessory={
              progress.phase === "downloading" ? (
                <Button label={gt("Cancel")} tone="text" size="compact" onPress={props.onCancel} />
              ) : undefined
            }
          />
          <View className="px-4 pb-3">
            <Progress
              label={`${props.name} download`}
              value={progress.phase === "preparing" ? undefined : progress.fraction}
            />
          </View>
        </>
      )}
      {error === null ? null : (
        <Text className="px-4 pb-3 text-sm text-danger-foreground">{error}</Text>
      )}
    </View>
  );
}
