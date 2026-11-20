import { useAtomValue } from "@effect/atom-react";
import { profileNameError } from "@t3tools/client-runtime/profiles-editor";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProfilesEditorState, ProfilesSkillsInput } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Notice } from "../../components/ui/Notice";
import { profilesEnvironment } from "../../state/profiles";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export function ProfileSkillsSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly state: ProfilesEditorState;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canRun = useAtomValue(profilesEnvironment.runSkills.permissionAtom(props.environmentId));
  const run = useAtomCommand(profilesEnvironment.runSkills, { reportFailure: false });
  const [running, setRunning] = useState(false);
  const pending = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [skill, setSkill] = useState("");
  const skillError = skill === "" ? null : profileNameError(skill, [], messages);
  const disabled = !canRun || running;
  async function runSkills(input: ProfilesSkillsInput) {
    if (!canRun || pending.current) return;
    pending.current = true;
    setRunning(true);
    setFailure(null);
    setOutput(null);
    const result = await run({ environmentId: props.environmentId, input });
    pending.current = false;
    setRunning(false);
    if (result._tag === "Success") {
      setOutput(result.value.output);
      if (input._tag === "add") {
        setSource("");
        setSkill("");
      }
    } else {
      const error = squashAtomCommandFailure(result);
      setFailure(error instanceof Error ? error.message : gt("Could not update skills."));
    }
  }
  return (
    <SettingsSection
      title={gt("Skills")}
      footer={gt(
        "Skill commands run on the selected environment. Dependencies are installed on that machine only.",
      )}
    >
      <View className="gap-3 p-4">
        <Button
          label={gt("Update all")}
          loading={running}
          disabled={disabled}
          onPress={() => void runSkills({ _tag: "update" })}
        />
        {!canRun ? (
          <Text className="text-sm text-foreground-muted">
            <T>Provider management permission is required to manage skills.</T>
          </Text>
        ) : null}
        {props.state.skills.length === 0 ? (
          <Text className="text-foreground-muted">
            <T>No skills</T>
          </Text>
        ) : null}
        {props.state.skills.map((entry) => (
          <View key={entry.name} className="gap-2 border-t border-border-subtle pt-3">
            <Text className="font-t3-medium text-foreground">{entry.name}</Text>
            {entry.description ? (
              <Text className="text-sm text-foreground-muted">{entry.description}</Text>
            ) : null}
            <Text selectable className="text-sm text-foreground-muted">
              {entry.source ?? gt("local", { $context: "skill source, installed locally" })}
            </Text>
            {entry.warning ? <Notice message={entry.warning} /> : null}
            {entry.needsInstall ? (
              <>
                <Text className="text-sm text-foreground-muted">
                  <T>Dependencies need installing on this machine.</T>
                </Text>
                <Button
                  label={gt("Install dependencies")}
                  disabled={disabled}
                  onPress={() => void runSkills({ _tag: "install", name: entry.name })}
                />
              </>
            ) : null}
            <Button
              label={gt("Remove")}
              tone="danger"
              disabled={disabled}
              onPress={() =>
                Dialog.confirm({
                  title: gt("Remove skill “{name}”?", { name: entry.name }),
                  message: gt(
                    "Profiles using this skill will show a warning until you remove its reference or add it again.",
                  ),
                  confirmText: gt("Remove"),
                  destructive: true,
                  onConfirm: () => void runSkills({ _tag: "remove", name: entry.name }),
                })
              }
            />
          </View>
        ))}
        <Text className="font-t3-medium text-foreground">
          <T>Add skill</T>
        </Text>
        <TextInput
          accessibilityLabel={gt("Skill source")}
          className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder={gt("owner/repo or source URL")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          value={source}
          onChangeText={setSource}
        />
        <TextInput
          accessibilityLabel={gt("Optional skill name")}
          className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder={gt("Skill name (optional)")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          value={skill}
          onChangeText={setSkill}
        />
        {skillError ? <Text className="text-sm text-danger-foreground">{skillError}</Text> : null}
        <Button
          label={gt("Add skill")}
          disabled={disabled || !source.trim() || skillError !== null}
          onPress={() =>
            void runSkills({ _tag: "add", source: source.trim(), ...(skill ? { skill } : {}) })
          }
        />
        {failure ? <Notice tone="danger" message={failure} /> : null}
        {output ? (
          <Text selectable className="font-mono text-sm text-foreground-muted">
            {output}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
