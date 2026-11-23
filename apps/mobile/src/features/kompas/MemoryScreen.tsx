import { memoryInScope } from "@t3tools/client-runtime/state/kompas";
import { MEMORY_LIMITS, type MemoryEntry } from "@t3tools/contracts";
import { useGT, useLocale } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { Bar, Card, KompasPage } from "./KompasPage";
import { type Kompas, kompasEnvironment, reportFailure } from "./state";

function EntryEditor(props: {
  readonly kompas: Kompas;
  readonly scope: string;
  readonly entry: MemoryEntry | null;
  readonly onClose: () => void;
}) {
  const { entry } = props;
  const { environmentId } = props.kompas;
  const gt = useGT();
  const saveMemory = useAtomCommand(kompasEnvironment.saveMemory, { reportFailure: false });
  const removeMemory = useAtomCommand(kompasEnvironment.removeMemory, { reportFailure: false });
  const [text, setText] = useState(entry?.text ?? "");
  const save = async () => {
    const result = await saveMemory({
      environmentId,
      input: { ...(entry === null ? {} : { id: entry.id }), scope: props.scope, text },
    });
    if (reportFailure(result)) props.onClose();
  };
  return (
    <View className="gap-2 py-2">
      <TextInput
        autoFocus
        multiline
        accessibilityLabel={gt("Memory entry")}
        value={text}
        onChangeText={setText}
      />
      <View className="flex-row gap-2">
        <Button
          tone="primary"
          size="compact"
          label={gt("Save")}
          disabled={text.trim() === ""}
          onPress={() => void save()}
        />
        <Button tone="text" size="compact" label={gt("Cancel")} onPress={props.onClose} />
        {entry === null ? null : (
          <Button
            tone="text"
            size="compact"
            label={gt("Forget this")}
            onPress={() =>
              void removeMemory({ environmentId, input: { id: entry.id } }).then(reportFailure)
            }
          />
        )}
      </View>
    </View>
  );
}

export function MemoryScopeCard(props: {
  readonly kompas: Kompas;
  readonly scope: string;
  readonly title: string;
  readonly detail: string;
}) {
  const gt = useGT();
  const locale = useLocale();
  const [editing, setEditing] = useState<string | null>(null);
  const { entries, used } = memoryInScope(props.kompas.snapshot, props.scope);
  const limit =
    props.scope === "user" || props.scope === "notes"
      ? MEMORY_LIMITS[props.scope]
      : MEMORY_LIMITS.project;
  return (
    <Card>
      <Text className="font-t3-bold text-base">{props.title}</Text>
      <Text className="text-sm text-foreground-muted">{props.detail}</Text>
      <View className="flex-row items-center gap-3">
        <Bar value={used / limit} label={gt("Memory used")} />
        <Text className="text-xs text-foreground-muted">
          {used.toLocaleString(locale)} / {limit.toLocaleString(locale)}
        </Text>
      </View>
      {entries.map((entry) =>
        editing === entry.id ? (
          <EntryEditor
            key={entry.id}
            kompas={props.kompas}
            scope={props.scope}
            entry={entry}
            onClose={() => setEditing(null)}
          />
        ) : (
          <Pressable
            key={entry.id}
            accessibilityRole="button"
            accessibilityHint={gt("Edit entry")}
            onPress={() => setEditing(entry.id)}
            className="border-t border-border-subtle py-2 active:opacity-70"
          >
            <Text className="text-base">{entry.text}</Text>
            <Text className="text-xs text-foreground-muted">{entry.model ?? gt("You")}</Text>
          </Pressable>
        ),
      )}
      {editing === "new" ? (
        <EntryEditor
          kompas={props.kompas}
          scope={props.scope}
          entry={null}
          onClose={() => setEditing(null)}
        />
      ) : (
        <Button
          tone="text"
          size="compact"
          icon="plus"
          label={gt("Add")}
          onPress={() => setEditing("new")}
        />
      )}
    </Card>
  );
}

function Proposals({ kompas }: { readonly kompas: Kompas }) {
  const gt = useGT();
  const resolveMemory = useAtomCommand(kompasEnvironment.resolveMemory, { reportFailure: false });
  const { memory } = kompas.snapshot;
  return memory
    .filter((entry) => entry.status === "proposed")
    .map((entry) => {
      const author = entry.model ?? gt("The model");
      const resolve = (approve: boolean) =>
        void resolveMemory({
          environmentId: kompas.environmentId,
          input: { id: entry.id, approve },
        }).then(reportFailure);
      return (
        <Card key={entry.id} highlighted>
          <Text className="font-t3-medium text-sm text-primary">
            {entry.text === ""
              ? gt("{model} wants to forget", { model: author })
              : gt("{model} wants to remember", { model: author })}
          </Text>
          <Text className="text-base">
            {entry.text === ""
              ? memory.find((candidate) => candidate.id === entry.replacesId)?.text
              : entry.text}
          </Text>
          <View className="flex-row gap-2">
            <Button
              tone="primary"
              size="compact"
              label={gt("Save")}
              onPress={() => resolve(true)}
            />
            <Button size="compact" label={gt("Reject")} onPress={() => resolve(false)} />
          </View>
        </Card>
      );
    });
}

export function MemoryScreen() {
  const gt = useGT();
  const updateSettings = useAtomCommand(kompasEnvironment.updateSettings, { reportFailure: false });
  return (
    <KompasPage title={gt("Memory")} tab>
      {(kompas) => {
        const { settings, workstreams } = kompas.snapshot;
        const update = (input: Partial<typeof settings>) =>
          void updateSettings({ environmentId: kompas.environmentId, input }).then(reportFailure);
        return (
          <>
            <Proposals kompas={kompas} />
            <MemoryScopeCard
              kompas={kompas}
              scope="user"
              title={gt("Profile")}
              detail={gt("Who you are and how you like to talk")}
            />
            <MemoryScopeCard
              kompas={kompas}
              scope="notes"
              title={gt("Assistant notes")}
              detail={gt("Agreements and facts from conversations")}
            />
            {workstreams.map((workstream) => (
              <MemoryScopeCard
                key={workstream.id}
                kompas={kompas}
                scope={`project:${workstream.id}`}
                title={workstream.title}
                detail={gt("Only this project's threads see it")}
              />
            ))}
            <SettingsSection>
              <SettingsSwitchRow
                label={gt("Ask me before a model remembers something")}
                value={settings.memoryAskBeforeSaving}
                onValueChange={(memoryAskBeforeSaving) => update({ memoryAskBeforeSaving })}
              />
              <SettingsSwitchRow
                label={gt("Let models search past conversations")}
                value={settings.memorySearchEnabled}
                onValueChange={(memorySearchEnabled) => update({ memorySearchEnabled })}
              />
            </SettingsSection>
          </>
        );
      }}
    </KompasPage>
  );
}
