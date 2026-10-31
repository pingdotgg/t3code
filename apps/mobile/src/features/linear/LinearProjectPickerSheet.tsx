import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { LinearLaunchWorkspace } from "@t3tools/client-runtime/linear/launch-plan";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useServerConfigs } from "../../state/entities";
import { startLinearChatDraft } from "./linearChatDraft";
import { linearDraftRoute } from "./useLinearLaunch";
import { useLinearIssueDetail } from "./useLinearData";

type LinearProjectPickerRouteParams = {
  readonly environmentId: string;
  readonly issueId: string;
  readonly workspace?: LinearLaunchWorkspace;
};

/** Asks which T3 project an issue belongs to when no Linear mapping covers it. */
export function LinearProjectPickerSheet({
  route,
}: StaticScreenProps<LinearProjectPickerRouteParams>) {
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const serverConfigs = useServerConfigs();
  const scratchRoot = serverConfigs.get(environmentId)?.scratchWorkspaceRoot;
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !isScratchProject(project, scratchRoot),
  );
  const issue = useLinearIssueDetail(environmentId, params.issueId).data?.issue ?? null;
  const [opening, setOpening] = useState<ProjectId | null>(null);

  const choose = async (projectId: ProjectId) => {
    if (opening !== null) return;
    setOpening(projectId);
    const started = await startLinearChatDraft({
      environmentId,
      issueId: params.issueId,
      workspace: params.workspace,
      projectId,
    });
    setOpening(null);
    if (started.kind === "opened") {
      navigation.dispatch(
        StackActions.replace(
          "Thread",
          linearDraftRoute({
            environmentId: params.environmentId,
            projectId: String(projectId),
            draftKey: started.draftKey,
            identifier: started.identifier,
          }),
        ),
      );
    } else if (started.kind === "failed") {
      Dialog.alert("Could not start a chat", started.message);
    }
  };

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      <SheetHeader
        presentation={Platform.OS === "android" ? "inline" : "native"}
        title={issue ? `Which project is ${issue.identifier} in?` : "Choose a project"}
        onCancel={() => navigation.goBack()}
        accessibilityLabel="Cancel"
      />
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          contentInsetAdjustmentBehavior="automatic"
          className="android:shrink android:grow-0 ios:flex-1"
          contentContainerClassName="px-5 pt-4 gap-1"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="pb-2 text-sm text-foreground-muted">
            No Linear mapping covers {issue ? issue.team.name : "this issue"}
            {issue?.project ? ` or ${issue.project.name}` : ""}. Add one in T3 Code on your computer
            to skip this step next time.
          </Text>
          {projects.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              This environment has no projects yet.
            </Text>
          ) : null}
          {projects.map((project) => (
            <Pressable
              key={project.id}
              accessibilityRole="button"
              accessibilityLabel={project.title}
              disabled={opening !== null}
              onPress={() => void choose(project.id)}
              className="min-h-12 justify-center border-t border-border-subtle py-2 active:opacity-65"
            >
              <Text numberOfLines={1} className="text-base font-t3-medium text-foreground">
                {project.title}
              </Text>
              <Text numberOfLines={1} className="text-xs text-foreground-muted">
                {project.workspaceRoot}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
