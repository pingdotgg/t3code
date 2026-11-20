import { useGT, T } from "gt-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { forgetPair, saveRule, type CorrectionPair } from "./correctionLearning";
import { dictationNative } from "./dictationNative";
import {
  updateDictationLearning,
  updateDictationSettings,
  useDictationState,
} from "./dictationRuntime";
import { DictationSettingsPage, DictationUnavailable, Footnote } from "./DictationSettingsPage";
import { ruleKey } from "./replacementRules";

const FIELD_CLASS_NAME =
  "min-h-0 flex-1 rounded-none border-0 bg-transparent p-0 text-base leading-[23px]";

const TITLE = "Corrections";

export function SettingsDictationCorrectionsRouteScreen() {
  return dictationNative === null ? (
    <DictationUnavailable title={TITLE} />
  ) : (
    <DictationCorrections />
  );
}

function DictationCorrections() {
  const gt = useGT();
  const { settings, learning } = useDictationState();
  const [heard, setHeard] = useState("");
  const [written, setWritten] = useState("");
  const suggestions = learning.candidates.filter((candidate) => candidate.suggested);
  const canAdd = ruleKey(heard).length > 0 && written.trim().length > 0;

  const add = () => {
    updateDictationLearning((state) => saveRule(state, { heard, written }, "manual", Date.now()));
    setHeard("");
    setWritten("");
  };

  const review = (pair: CorrectionPair) =>
    Alert.alert(
      gt('Replace "{heard}" with "{written}"?', { heard: pair.heard, written: pair.written }),
      undefined,
      [
        {
          text: gt("Always replace"),
          onPress: () =>
            updateDictationLearning((state) => saveRule(state, pair, "learned", Date.now())),
        },
        {
          text: gt("Never"),
          style: "destructive",
          onPress: () => updateDictationLearning((state) => forgetPair(state, pair)),
        },
        { text: gt("Cancel"), style: "cancel" },
      ],
    );

  const confirmDelete = (pair: CorrectionPair) =>
    Alert.alert(gt('Stop replacing "{heard}"?', { heard: pair.heard }), undefined, [
      { text: gt("Cancel"), style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => updateDictationLearning((state) => forgetPair(state, pair)),
      },
    ]);

  return (
    <DictationSettingsPage title={TITLE}>
      <SettingsSection>
        <ListToggleRow
          icon="pencil"
          label={gt("Learn from my corrections")}
          description={gt(
            "Notices the words you fix before sending. A name or a term fixed twice becomes a replacement. Everyday words are suggested first.",
          )}
          value={settings.learnCorrections}
          onValueChange={(learnCorrections) => updateDictationSettings({ learnCorrections })}
        />
      </SettingsSection>

      {suggestions.length === 0 ? null : (
        <SettingsSection title={gt("Suggestions")}>
          {suggestions.map((pair, index) => (
            <View
              key={`${pair.heard}\n${pair.written}`}
              className={index > 0 ? "border-t border-border-subtle" : undefined}
            >
              <ListRow
                label={`${pair.heard} → ${pair.written}`}
                description={gt("Corrected {length} times", { length: pair.sightings.length })}
                onPress={() => review(pair)}
              />
            </View>
          ))}
        </SettingsSection>
      )}

      <SettingsSection title={gt("Add a replacement")}>
        <View className="h-13 flex-row items-center gap-3 px-4">
          <Text className="w-20 text-base leading-[23px] text-foreground-muted">
            <T>Heard</T>
          </Text>
          <AppTextInput
            accessibilityLabel={gt("Heard")}
            autoCapitalize="none"
            autoCorrect={false}
            className={FIELD_CLASS_NAME}
            placeholder={gt("pseudo code")}
            value={heard}
            onChangeText={setHeard}
          />
        </View>
        <View className="h-13 flex-row items-center gap-3 border-t border-border-subtle px-4">
          <Text className="w-20 text-base leading-[23px] text-foreground-muted">
            <T>Written</T>
          </Text>
          <AppTextInput
            accessibilityLabel={gt("Written")}
            autoCapitalize="none"
            autoCorrect={false}
            className={FIELD_CLASS_NAME}
            placeholder="PseudoCode"
            value={written}
            onChangeText={setWritten}
            onSubmitEditing={() => {
              if (canAdd) add();
            }}
          />
        </View>
        <View className="border-t border-border-subtle px-4 py-3">
          <Button label={gt("Add")} icon="plus" size="compact" disabled={!canAdd} onPress={add} />
        </View>
      </SettingsSection>

      <SettingsSection title={gt("Replacements")}>
        {learning.rules.length === 0 ? (
          <Text className="px-4 py-4 text-base text-foreground-muted">
            <T>No replacements yet.</T>
          </Text>
        ) : (
          learning.rules.map((rule, index) => (
            <View
              key={rule.heard}
              className={index > 0 ? "border-t border-border-subtle" : undefined}
            >
              <ListRow
                label={`${rule.heard} → ${rule.written}`}
                detail={rule.source === "learned" ? gt("Learned") : gt("Added")}
                onPress={() => confirmDelete(rule)}
              />
            </View>
          ))
        )}
      </SettingsSection>

      <Footnote>
        <T>
          Replacements apply to whole words in every dictation, whichever model wrote them. They are
          kept in this app's data, which your device backups include.
        </T>
      </Footnote>
    </DictationSettingsPage>
  );
}
