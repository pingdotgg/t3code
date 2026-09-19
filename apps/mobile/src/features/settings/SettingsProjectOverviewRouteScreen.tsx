import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useConfirmRemoveProjects } from "../projects/useConfirmRemoveProjects";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsProjectOverviewRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { selectedTargets, projectGroups, selectedProjectKey, selectProject } =
    useSettingsEnvironmentFilter();
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  // Once the whole project is gone there is nothing left to show here, and
  // the settings index should stop scoping to it.
  const handleProjectRemoved = () => {
    selectProject(null);
    if (navigation.canGoBack()) navigation.goBack();
  };
  const selectedEnvironmentIds = new Set(selectedTargets.map((entry) => entry.environmentId));
  const members =
    group?.members
      .map((entry) => entry.project)
      .filter((project) => selectedEnvironmentIds.has(project.environmentId)) ?? [];

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Project overview" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {members.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              This project has no checkout on the selected connected environments. Change the filter
              above.
            </Text>
          ) : (
            <ProjectOverviewContent
              key={`${selectedProjectKey}:${members.map((member) => member.id).join(",")}`}
              members={members}
              groupMemberCount={group?.members.length ?? members.length}
              environments={selectedTargets}
              onProjectRemoved={handleProjectRemoved}
            />
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function ProjectOverviewContent(props: {
  readonly members: readonly EnvironmentProject[];
  /** Every checkout in the grouped project, including ones outside the environment filter. */
  readonly groupMemberCount: number;
  readonly environments: readonly SettingsTarget[];
  readonly onProjectRemoved: () => void;
}) {
  const representative = props.members[0]!;
  const displayName = deriveProjectGroupLabel({ representative, members: props.members });
  const [draftName, setDraftName] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const updateProject = useAtomCommand(projectEnvironment.update, {
    label: "project name update",
    reportFailure: true,
  });
  const confirmRemoveProjects = useConfirmRemoveProjects();
  const removeMembers = (members: readonly EnvironmentProject[]) => {
    if (isRemoving) return;
    const isWholeGroup = members.length === props.groupMemberCount;
    setIsRemoving(true);
    void (async () => {
      try {
        const removed = await confirmRemoveProjects(members, {
          groupTitle: displayName,
          isWholeGroup,
        });
        if (removed && isWholeGroup) props.onProjectRemoved();
      } finally {
        setIsRemoving(false);
      }
    })();
  };
  const nextName = (draftName ?? displayName).trim();
  const canSave = !isSaving && nextName.length > 0 && nextName !== displayName;

  const saveName = () => {
    if (!canSave) return;
    setIsSaving(true);
    void (async () => {
      try {
        const results = await Promise.all(
          props.members.map((member) =>
            updateProject({
              environmentId: member.environmentId,
              input: { projectId: member.id, title: nextName },
            }),
          ),
        );
        if (results.every((result) => result._tag !== "Failure")) setDraftName(null);
      } finally {
        setIsSaving(false);
      }
    })();
  };

  return (
    <>
      <View className="flex-row items-center gap-4 px-2">
        <ProjectFavicon
          environmentId={representative.environmentId}
          projectTitle={displayName}
          workspaceRoot={representative.workspaceRoot}
          faviconPath={representative.faviconPath}
          size={48}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-xl font-t3-semibold text-foreground" numberOfLines={2}>
            {displayName}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {props.members.length === 1 ? "1 checkout" : `${props.members.length} checkouts`}
          </Text>
        </View>
      </View>

      <SettingsSection title="Project">
        <View className="gap-3 p-4">
          <Text className="text-sm font-t3-medium text-foreground-muted">Name</Text>
          <View className="flex-row items-center gap-3">
            <AppTextInput
              accessibilityLabel="Project name"
              className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
              value={draftName ?? displayName}
              onChangeText={setDraftName}
              onSubmitEditing={saveName}
              returnKeyType="done"
              editable={!isSaving}
            />
            {canSave ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Save project name"
                onPress={saveName}
                className="rounded-full bg-subtle-strong px-4 py-2 active:opacity-70"
              >
                <Text className="text-sm font-t3-medium text-foreground">Save</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title="Checkouts">
        {props.members.map((member, index) => {
          const environment = props.environments.find(
            (entry) => entry.environmentId === member.environmentId,
          );
          return (
            <View
              key={`${member.environmentId}:${member.id}`}
              className={
                index === 0
                  ? "flex-row items-center gap-3 p-4"
                  : "flex-row items-center gap-3 border-t border-border-subtle p-4"
              }
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text
                  className={
                    Platform.OS === "android"
                      ? "text-base text-foreground"
                      : "text-lg text-foreground"
                  }
                >
                  {environment?.label ?? "Environment"}
                </Text>
                {environment?.displayUrl ? (
                  <Text className="text-sm leading-normal text-foreground-muted">
                    {environment.displayUrl}
                  </Text>
                ) : null}
                <Text className="text-sm leading-normal text-foreground-muted" selectable>
                  {member.workspaceRoot}
                </Text>
              </View>
              {props.groupMemberCount > 1 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove checkout ${member.workspaceRoot}`}
                  disabled={isRemoving}
                  onPress={() => removeMembers([member])}
                  className="rounded-full px-3 py-2 disabled:opacity-40"
                >
                  <Text className="font-t3-medium text-danger-foreground">Remove</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </SettingsSection>

      <SettingsSection>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove project ${displayName}`}
          disabled={isRemoving}
          onPress={() => removeMembers(props.members)}
          className="items-center p-4 active:opacity-70 disabled:opacity-40"
        >
          <Text className="text-base font-t3-medium text-danger-foreground">Remove project</Text>
        </Pressable>
        <Text className="px-4 pb-4 text-sm leading-normal text-foreground-muted">
          Removes the project and its threads from T3 Code. Files on disk are not touched.
        </Text>
      </SettingsSection>
    </>
  );
}
