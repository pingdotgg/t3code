import { msg, T, useGT } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  type BotAvatarColor,
  type BotAvatarShape,
  type EnvironmentId,
  type ProjectBot,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { m } from "../../i18n/messages";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useBotProject } from "../../state/bots";
import { useEnvironmentServerConfig } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { fileRoutePathSegments } from "../files/filePath";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { describeSchedule } from "../settings/scheduledTaskPresentation";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";
import { BotAvatar } from "./BotAvatar";
import { BotAvatarPicker } from "./BotAvatarPicker";

const ARTIFACTS_DIRECTORY = "artifacts";

type BotProject = EnvironmentProject & { readonly bot: ProjectBot };

function alertFailure<A, E>(title: string, result: AtomCommandResult<A, E>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  Dialog.alert(title, error instanceof Error ? error.message : m(msg("An error occurred.")));
}

export function BotDetailsRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }>) {
  const project = useBotProject(route.params.environmentId, route.params.projectId);
  const bot = project?.bot;
  const gt = useGT();
  return (
    <SettingsScreen title={gt("Bot", { $context: "screen title, details of one bot" })}>
      {project && bot ? (
        <BotDetails project={{ ...project, bot }} />
      ) : (
        <Text className="p-5 text-base text-foreground-muted">
          <T>This bot no longer exists.</T>
        </Text>
      )}
    </SettingsScreen>
  );
}

function BotDetails(props: { readonly project: BotProject }) {
  const { project } = props;
  const source = { environmentId: project.environmentId, threadId: project.bot.threadId };
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-6 px-5 pb-10 pt-4"
    >
      <View className="items-center gap-3">
        <BotAvatar avatar={project.bot.avatar} size={88} source={source} animateChanges />
        <Text className="text-center text-xl font-t3-bold text-foreground" numberOfLines={2}>
          {project.title}
        </Text>
      </View>
      <BotAvatarSection project={project} />
      <BotProfileSection
        key={`${project.title}\n${project.bot.description ?? ""}`}
        project={project}
      />
      <BotArtifactsSection project={project} />
      <BotRoutinesSection project={project} />
      <BotComputerSection project={project} />
      <BotDeleteSection project={project} />
    </ScrollView>
  );
}

function sameAvatar(left: ProjectBot["avatar"], right: ProjectBot["avatar"]) {
  return (
    left.shape === right.shape &&
    left.color === right.color &&
    (left.imagePath ?? null) === (right.imagePath ?? null)
  );
}

function BotAvatarSection(props: { readonly project: BotProject }) {
  const { project } = props;
  const gt = useGT();
  const updateBot = useAtomCommand(serverEnvironment.updateBot, {
    label: "bot avatar update",
    reportFailure: false,
  });
  const generateAvatar = useAtomCommand(serverEnvironment.generateBotAvatar, {
    label: "bot avatar generate",
    reportFailure: false,
  });
  const canUpdate = useAtomValue(serverEnvironment.updateBot.permissionAtom(project.environmentId));
  const canGenerate = useAtomValue(
    serverEnvironment.generateBotAvatar.permissionAtom(project.environmentId),
  );
  const config = useEnvironmentServerConfig(project.environmentId);
  const codexReady =
    config?.providers.some(
      (provider) => provider.driver === "codex" && provider.enabled && provider.status === "ready",
    ) ?? false;
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  // The newest pick, shown until the bot's avatar changes from the one it was picked over, so quick
  // picks build on each other even when a save returns before the project update arrives.
  const [pending, setPending] = useState<{
    readonly change: { shape: BotAvatarShape; color: BotAvatarColor };
    readonly base: ProjectBot["avatar"];
  } | null>(null);
  const latestSave = useRef(0);
  const live = pending !== null && sameAvatar(pending.base, project.bot.avatar) ? pending : null;
  const avatar = live?.change ?? project.bot.avatar;
  // Drawn choices fall back to the first option when the server knows a newer one.
  const shape = BOT_AVATAR_SHAPES.find((value) => value === avatar.shape) ?? "circle";
  const color = BOT_AVATAR_COLORS.find((value) => value === avatar.color) ?? "gray";

  const saveAvatar = (next: { shape: BotAvatarShape; color: BotAvatarColor }) => {
    const save = ++latestSave.current;
    setPending({ change: next, base: live?.base ?? project.bot.avatar });
    void updateBot({
      environmentId: project.environmentId,
      // Picking a drawn avatar replaces a generated image.
      input: { projectId: project.id, avatar: { ...next, imagePath: null } },
    }).then((result) => {
      if (result._tag === "Failure" && save === latestSave.current) setPending(null);
      alertFailure(gt("Couldn't update avatar"), result);
    });
  };
  const generate = () => {
    setGenerating(true);
    const trimmed = prompt.trim();
    void generateAvatar({
      environmentId: project.environmentId,
      input: { projectId: project.id, ...(trimmed ? { prompt: trimmed } : {}) },
    }).then((result) => {
      setGenerating(false);
      if (result._tag === "Failure") {
        alertFailure(gt("Couldn't generate image"), result);
        return;
      }
      void updateBot({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          avatar: { shape, color, imagePath: result.value.imagePath },
        },
      }).then((update) => alertFailure(gt("Couldn't update avatar"), update));
    });
  };

  return (
    <SettingsSection title={gt("Avatar")}>
      <BotAvatarPicker shape={shape} color={color} disabled={!canUpdate} onChange={saveAvatar} />
      {codexReady && canGenerate ? (
        <View className="gap-3 px-4 pb-4">
          <AppTextInput
            accessibilityLabel={gt("Avatar idea")}
            className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
            value={prompt}
            maxLength={500}
            placeholder={gt("Avatar for {name}", { name: project.title })}
            editable={!generating && canUpdate}
            returnKeyType="go"
            onChangeText={setPrompt}
            onSubmitEditing={generate}
          />
          <Button
            label={generating ? gt("Generating image...") : gt("Generate image")}
            icon="photo"
            disabled={generating || !canUpdate}
            onPress={generate}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}

function BotProfileSection(props: { readonly project: BotProject }) {
  const { project } = props;
  const gt = useGT();
  const updateBot = useAtomCommand(serverEnvironment.updateBot, {
    label: "bot profile update",
    reportFailure: false,
  });
  const canUpdate = useAtomValue(serverEnvironment.updateBot.permissionAtom(project.environmentId));
  const [name, setName] = useState(project.title);
  const [description, setDescription] = useState(project.bot.description ?? "");
  const [saving, setSaving] = useState(false);
  const nextName = name.trim();
  const nextDescription = description.trim();
  const changed = nextName !== project.title || nextDescription !== (project.bot.description ?? "");
  const save = () => {
    if (!changed || nextName.length === 0 || saving) return;
    setSaving(true);
    void updateBot({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        ...(nextName !== project.title ? { name: nextName } : {}),
        description: nextDescription.length > 0 ? nextDescription : null,
      },
    }).then((result) => {
      setSaving(false);
      alertFailure(gt("Couldn't save bot"), result);
    });
  };

  return (
    <SettingsSection title={gt("Profile")}>
      <View className="gap-3 p-4">
        <Text className="text-sm font-t3-medium text-foreground-muted">
          <T>Name</T>
        </Text>
        <AppTextInput
          accessibilityLabel={gt("Bot name")}
          className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          editable={canUpdate && !saving}
          onChangeText={setName}
        />
        <Text className="text-sm font-t3-medium text-foreground-muted">
          <T>Description</T>
        </Text>
        <AppTextInput
          accessibilityLabel={gt("Bot description")}
          className="min-h-24 rounded-xl border-continuous bg-card px-3 py-2 text-base text-foreground"
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          multiline
          textAlignVertical="top"
          placeholder={gt("What this bot is for")}
          editable={canUpdate && !saving}
          onChangeText={setDescription}
        />
        {changed ? (
          <Button
            label={saving ? gt("Saving...") : gt("Save")}
            tone="primary"
            disabled={saving || nextName.length === 0}
            onPress={save}
          />
        ) : null}
      </View>
    </SettingsSection>
  );
}

function BotArtifactsSection(props: { readonly project: BotProject }) {
  const { project } = props;
  const gt = useGT();
  const navigation = useNavigation();
  const query = useEnvironmentQuery(
    projectEnvironment.listEntries({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot, directoryPath: ARTIFACTS_DIRECTORY },
    }),
  );
  const files = (query.data?.entries ?? []).filter(
    (entry) => entry.kind === "file" && entry.path.startsWith(`${ARTIFACTS_DIRECTORY}/`),
  );
  return (
    <SettingsSection title={gt("Artifacts")}>
      {files.length === 0 ? (
        <ListRowLayout
          label={query.isPending ? gt("Loading...") : gt("No artifacts yet")}
          disabled
        />
      ) : (
        files.map((file) => (
          <ListRow
            key={file.path}
            leading={<PierreEntryIcon path={file.path} kind="file" size={22} />}
            label={file.path.slice(ARTIFACTS_DIRECTORY.length + 1)}
            onPress={() =>
              navigation.navigate("ThreadFile", {
                environmentId: String(project.environmentId),
                threadId: String(project.bot.threadId),
                path: fileRoutePathSegments(file.path),
              })
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

function BotRoutinesSection(props: { readonly project: BotProject }) {
  const { project } = props;
  const gt = useGT();
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: project.environmentId, input: {} }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(project.environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "bot routine toggle",
    reportFailure: false,
  });
  const routines = (query.data?.tasks ?? []).filter(
    (task) => task.threadId === project.bot.threadId,
  );
  return (
    <SettingsSection title={gt("Routines")}>
      {routines.length === 0 ? (
        <ListRowLayout
          label={query.isPending ? gt("Loading...") : gt("No routines yet")}
          disabled
        />
      ) : (
        routines.map((task) => (
          <ListToggleRow
            key={task.id}
            label={task.title}
            description={describeSchedule(task)}
            value={task.enabled}
            disabled={!canOperate}
            onValueChange={(enabled) =>
              void setEnabled({
                environmentId: project.environmentId,
                input: { id: task.id, enabled },
              }).then((result) => alertFailure(gt("Couldn't update routine"), result))
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

function BotComputerSection(props: { readonly project: BotProject }) {
  const gt = useGT();
  const environment = useWorkspaceEnvironments().find(
    (entry) => entry.environmentId === props.project.environmentId,
  );
  return (
    <SettingsSection title={gt("Computer")}>
      <ListRowLayout label={environment?.environmentLabel ?? gt("Unknown machine")} />
    </SettingsSection>
  );
}

function BotDeleteSection(props: { readonly project: BotProject }) {
  const { project } = props;
  const gt = useGT();
  const selectTab = useSelectWorkspaceTab();
  const canDelete = useAtomValue(serverEnvironment.deleteBot.permissionAtom(project.environmentId));
  const deleteBot = useAtomCommand(serverEnvironment.deleteBot, {
    label: "bot delete",
    reportFailure: false,
  });
  const [deleting, setDeleting] = useState(false);
  const confirmDelete = () =>
    Dialog.prompt({
      title: gt("Delete {name}?", { name: project.title }),
      message: gt(
        "Its chat and routines stop for good. Files in its folder stay on disk. Type {name} to confirm.",
        { name: project.title },
      ),
      placeholder: project.title,
      initialValue: "",
      confirmText: gt("Delete"),
      onConfirm: (typed) => {
        if (typed.trim() !== project.title) {
          Dialog.alert(gt("Name didn't match"), gt("The bot was not deleted."));
          return;
        }
        setDeleting(true);
        void deleteBot({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        }).then((result) => {
          setDeleting(false);
          if (result._tag === "Failure") {
            alertFailure(gt("Couldn't delete bot"), result);
            return;
          }
          selectTab("bots");
        });
      },
    });
  return (
    <Button
      label={deleting ? gt("Deleting...") : gt("Delete bot")}
      tone="danger"
      fullWidth
      disabled={!canDelete || deleting}
      onPress={confirmDelete}
    />
  );
}
