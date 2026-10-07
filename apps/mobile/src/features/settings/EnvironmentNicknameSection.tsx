import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";

export function EnvironmentNicknameSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const entry = catalog.entries.get(environmentId);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = useAtomCommand(environmentCatalog.setNickname, "Save environment nickname");
  if (!entry) return null;

  return (
    <SettingsSection title="Nickname">
      {draft === null ? (
        <SettingsActionRow
          icon="square.and.pencil"
          label={entry.nickname ?? entry.target.label}
          onPress={() => setDraft(entry.nickname ?? "")}
        />
      ) : (
        <>
          <View className="gap-2 p-4">
            <TextInput
              accessibilityLabel="Environment nickname"
              value={draft}
              onChangeText={setDraft}
              placeholder={entry.target.label}
              placeholderTextColorClassName="accent-foreground-muted"
              className="font-sans text-base text-foreground"
              autoFocus
              autoCorrect={false}
              editable={!saving}
            />
            <Text className="text-sm text-foreground-muted">
              Saved on this device. Leave blank to use {entry.target.label}.
            </Text>
          </View>
          <SettingsActionRow
            icon="checkmark"
            label="Save nickname"
            disabled={saving}
            loading={saving}
            onPress={() => {
              if (saving) return;
              setSaving(true);
              void save({ environmentId, nickname: draft }).then((result) => {
                setSaving(false);
                if (result._tag === "Success") setDraft(null);
              });
            }}
          />
          <SettingsActionRow
            icon="xmark"
            label="Cancel"
            disabled={saving}
            onPress={() => setDraft(null)}
          />
        </>
      )}
    </SettingsSection>
  );
}
