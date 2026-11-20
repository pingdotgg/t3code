import { T, useGT } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { BOT_NAME_MAX_LENGTH, CommandId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { buildModelOptions } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { scheduledTaskDefaultModel } from "../settings/scheduledTaskDraft";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { BotAvatar } from "./BotAvatar";
import { BotAvatarPicker } from "./BotAvatarPicker";
import { botDraftAtom, updateBotDraft } from "./bot-draft";

/** Connected machines a bot can live on, the first being the default. */
export function useBotMachines() {
  return useWorkspaceEnvironments().filter(
    (environment) => environment.isEnabled && environment.connectionState === "connected",
  );
}

/** The draft's model, or the machine's default until the user picks one. */
export function useBotDraftModel(environmentId: EnvironmentId | null) {
  const draft = useAtomValue(botDraftAtom);
  const config = useEnvironmentServerConfig(environmentId);
  const selection = useMemo(
    () => draft.modelSelection ?? scheduledTaskDefaultModel(config, null),
    [config, draft.modelSelection],
  );
  return { config, selection };
}

export function NewBotRouteScreen() {
  const draft = useAtomValue(botDraftAtom);
  const machines = useBotMachines();
  const machine =
    machines.find((entry) => entry.environmentId === draft.environmentId) ?? machines[0] ?? null;
  const gt = useGT();
  return (
    <SettingsScreen title={gt("New bot")}>
      {machine ? (
        <NewBotForm
          environmentId={machine.environmentId}
          environmentLabel={machine.environmentLabel}
        />
      ) : (
        <Text className="p-5 text-base text-foreground-muted">
          <T>Connect a machine first.</T>
        </Text>
      )}
    </SettingsScreen>
  );
}

function NewBotForm(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const draft = useAtomValue(botDraftAtom);
  const machines = useBotMachines();
  const { config, selection } = useBotDraftModel(props.environmentId);
  const models = useMemo(
    () => buildModelOptions(config, selection, undefined, null),
    [config, selection],
  );
  const modelLabel =
    models.find(
      (option) =>
        option.selection.instanceId === selection?.instanceId &&
        option.selection.model === selection.model,
    )?.label ??
    selection?.model ??
    gt("No models available");
  const canCreate = useAtomValue(serverEnvironment.createBot.permissionAtom(props.environmentId));
  const createBot = useAtomCommand(serverEnvironment.createBot, {
    label: "bot create",
    reportFailure: false,
  });
  // One command id per form, so a retried submit after a dropped reply is not a second bot.
  const [commandId, setCommandId] = useState(() => CommandId.make(uuidv4()));
  const [saving, setSaving] = useState(false);
  const name = draft.name.trim();
  const ready = name.length > 0 && selection !== null && canCreate && !saving;

  const submit = () => {
    if (!ready || selection === null) return;
    setSaving(true);
    void (async () => {
      const result = await createBot({
        environmentId: props.environmentId,
        input: {
          commandId,
          name,
          avatar: { shape: draft.shape, color: draft.color },
          modelSelection: selection,
        },
      });
      setSaving(false);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Couldn't create bot"),
          error instanceof Error ? error.message : gt("An error occurred."),
        );
        return;
      }
      setCommandId(CommandId.make(uuidv4()));
      selectDetail({
        name: "Thread",
        params: {
          environmentId: String(props.environmentId),
          threadId: String(result.value.threadId),
        },
      });
    })();
  };

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-6 px-5 pb-10 pt-4"
    >
      <View className="items-center">
        <BotAvatar avatar={{ shape: draft.shape, color: draft.color }} size={88} animateChanges />
      </View>
      <SettingsSection>
        <View className="gap-2 p-4">
          <Text className="text-sm font-t3-medium text-foreground-muted">
            <T>Name</T>
          </Text>
          <AppTextInput
            accessibilityLabel={gt("Bot name")}
            className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
            value={draft.name}
            maxLength={BOT_NAME_MAX_LENGTH}
            placeholder={gt("Research helper")}
            autoFocus
            editable={!saving}
            returnKeyType="done"
            onChangeText={(value) => updateBotDraft({ name: value })}
            onSubmitEditing={submit}
          />
        </View>
      </SettingsSection>
      <SettingsSection title={gt("Avatar")}>
        <BotAvatarPicker
          shape={draft.shape}
          color={draft.color}
          disabled={saving}
          onChange={updateBotDraft}
        />
      </SettingsSection>
      <SettingsSection>
        <Menu
          actions={machines.map((machine) => ({
            id: machine.environmentId,
            title: machine.environmentLabel,
            state: machine.environmentId === props.environmentId ? "on" : undefined,
          }))}
          onPressAction={({ nativeEvent }) => {
            const next = machines.find((machine) => machine.environmentId === nativeEvent.event);
            // Models belong to a machine, so a new machine starts from its own default.
            if (next && next.environmentId !== props.environmentId)
              updateBotDraft({ environmentId: next.environmentId, modelSelection: null });
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Machine, {machine}", { machine: props.environmentLabel })}
            disabled={saving}
            className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle bg-grouped-card px-4 py-3 active:opacity-70"
          >
            <Text className="text-base text-foreground">
              <T>Machine</T>
            </Text>
            <Text className="flex-1 text-right text-base text-foreground-muted" numberOfLines={1}>
              {props.environmentLabel}
            </Text>
            <SymbolView
              name="chevron.down"
              size={14}
              tintColorClassName="accent-chevron"
              type="monochrome"
            />
          </Pressable>
        </Menu>
        <ListRow
          label={gt("Model")}
          detail={modelLabel}
          disabled={saving || models.length === 0}
          onPress={() => navigation.navigate("BotModel", { environmentId: props.environmentId })}
        />
      </SettingsSection>
      <Button
        label={saving ? gt("Creating...") : gt("Create bot")}
        tone="primary"
        fullWidth
        disabled={!ready}
        loading={saving}
        onPress={submit}
      />
    </ScrollView>
  );
}
