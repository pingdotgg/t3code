import { useGT, T } from "gt-react-native";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { ListRow } from "../../components/ui/ListRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useAppleDictationAvailable } from "./appleDictation";
import { dictationModelName } from "./dictationModels";
import { dictationNative } from "./dictationNative";
import { updateDictationSettings, useDictationState } from "./dictationRuntime";
import { Footnote } from "./DictationSettingsPage";
import { describeRun } from "./runSummary";

/** The fork's dictation settings, shown on the Voice page. */
export function DictationSettingsSection() {
  return dictationNative === null ? null : <DictationSettings />;
}

function DictationSettings() {
  const gt = useGT();
  const navigation = useNavigation();
  const { settings, learning, lastRun } = useDictationState();
  const appleMissing = useAppleDictationAvailable() === false;
  const voiceDetail = !settings.onlyMyVoice
    ? "Off"
    : settings.modelId === "apple"
      ? "Needs a model"
      : "On";
  const suggestions = learning.candidates.filter((candidate) => candidate.suggested).length;
  return (
    <>
      <SettingsSection title={gt("Dictation")}>
        <ListRow
          icon="brain"
          label={gt("Model")}
          detail={
            settings.modelId === "apple" && appleMissing
              ? gt("None")
              : dictationModelName(settings.modelId)
          }
          onPress={() => navigation.navigate("SettingsDictationModels")}
        />
        <View className="border-t border-border-subtle">
          <ListRow
            icon="person.fill.checkmark"
            label={gt("Only my voice")}
            detail={voiceDetail}
            onPress={() => navigation.navigate("SettingsDictationVoice")}
          />
        </View>
        <View className="border-t border-border-subtle">
          <ListRow
            icon="checkmark.circle"
            label={gt("Corrections")}
            detail={
              suggestions > 0
                ? gt("{suggestions} to review", { suggestions })
                : `${learning.rules.length}`
            }
            onPress={() => navigation.navigate("SettingsDictationCorrections")}
          />
        </View>
        <View className="border-t border-border-subtle">
          <ListToggleRow
            icon="text.word.spacing"
            label={gt("Remove ums and uhs")}
            value={settings.removeFillers}
            onValueChange={(removeFillers) => updateDictationSettings({ removeFillers })}
          />
        </View>
      </SettingsSection>
      {lastRun === null ? null : (
        <Footnote>
          <T>Last dictation:</T> {describeRun(lastRun)}
        </Footnote>
      )}
    </>
  );
}
