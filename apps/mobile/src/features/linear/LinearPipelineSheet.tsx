import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { LinearLaunchWorkspace } from "@t3tools/client-runtime/linear/launch-plan";
import {
  includesFromSettings,
  pipelineInputSummary,
  pipelineInputText,
  pipelineLaunchRecord,
  pipelineWorkspaceStrategy,
  resolveInitialPipelineId,
  resolvePipelineLaunch,
} from "@t3tools/client-runtime/linear/pipeline-dialog";
import { nextPipelineStartAttempt } from "@t3tools/client-runtime/pipeline-start";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { EnvironmentId, type PipelineId, type ProjectId } from "@t3tools/contracts";
import type { LinearIssueIncludes } from "@t3tools/shared/linearLaunch";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Chip } from "../../components/ui/Chip";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useServerConfigs } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { PullRequestMarkdown } from "../pull-requests/PullRequestMarkdown";
import { waitForThreadShell } from "../threads/wait-for-thread-shell";
import { linearSettingsOf } from "./linearLaunchHelpers";
import { recordLinearLaunch } from "./recordLinearLaunch";
import { useLinearLaunch } from "./useLinearLaunch";
import { useLinearIssueDetail, useLinearTeamMetadata } from "./useLinearData";

type LinearPipelineRouteParams = {
  readonly environmentId: string;
  readonly issueId: string;
  readonly pipelineId?: string;
};

function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}) {
  return (
    <View className="min-h-12 flex-row items-center gap-3 border-t border-border-subtle py-2">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <View className="min-w-0 flex-1 items-end">
        <Text numberOfLines={1} className="text-sm font-t3-medium text-foreground">
          {props.value}
        </Text>
        {props.hint ? <Text className="text-xs text-foreground-muted">{props.hint}</Text> : null}
      </View>
      <SymbolView name="chevron.down" size={12} tintColorClassName="accent-icon-muted" />
    </View>
  );
}

function ToggleRow(props: {
  readonly title: string;
  readonly description: string;
  readonly value: boolean;
  readonly disabled?: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View className="min-h-12 flex-row items-center gap-3 border-t border-border-subtle py-2">
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-t3-medium text-foreground">{props.title}</Text>
        <Text className="text-xs text-foreground-muted">{props.description}</Text>
      </View>
      <ThemedSwitch
        accessibilityLabel={props.title}
        disabled={props.disabled}
        value={props.value}
        onValueChange={props.onValueChange}
      />
    </View>
  );
}

/** "Run pipeline from issue": the issue as text input for a pipeline's first step. */
export function LinearPipelineSheet({ route }: StaticScreenProps<LinearPipelineRouteParams>) {
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { canRunPipeline } = useLinearLaunch(environmentId);
  const detail = useLinearIssueDetail(environmentId, params.issueId).data;
  const settings = linearSettingsOf(useServerConfigs().get(environmentId));
  const teamStates =
    useLinearTeamMetadata(environmentId, detail?.issue.team.id).data?.states ?? null;
  const pipelinesQuery = useEnvironmentQuery(
    canRunPipeline ? serverEnvironment.pipelinesLive({ environmentId, input: {} }) : null,
  );
  const pipelines = pipelinesQuery.data?.pipelines ?? [];
  const scratchRoot = useServerConfigs().get(environmentId)?.scratchWorkspaceRoot;
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !isScratchProject(project, scratchRoot),
  );
  const startPipelineRun = useAtomCommand(serverEnvironment.startPipelineRun, {
    label: "pipeline start",
    reportFailure: false,
  });
  const attemptRef = useRef<ReturnType<typeof nextPipelineStartAttempt> | null>(null);

  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const lastUsed = AsyncResult.isSuccess(preferences)
    ? (preferences.value.linearLastPipelineId ?? null)
    : null;
  const [pipelineChoice, setPipelineChoice] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "edit">("preview");
  const [edited, setEdited] = useState<string | null>(null);
  const [includeChoice, setIncludeChoice] = useState<LinearIssueIncludes | null>(null);
  const [projectChoice, setProjectChoice] = useState<ProjectId | null>(null);
  const [workspaceChoice, setWorkspaceChoice] = useState<LinearLaunchWorkspace | null>(null);
  const [moveChoice, setMoveChoice] = useState<boolean | null>(null);
  const [commentChoice, setCommentChoice] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = detail?.issue ?? null;
  const includes = includeChoice ?? includesFromSettings(settings);
  const workspace = workspaceChoice ?? settings.defaultWorkspace;
  const launch = issue
    ? resolvePipelineLaunch({
        issue,
        settings,
        teamStates,
        projectIds: projects.map((candidate) => candidate.id),
        choices: { projectId: projectChoice, move: moveChoice, comment: commentChoice },
      })
    : null;
  const mappedProjectId = launch?.mappedProjectId ?? null;
  const projectId = launch?.projectId ?? null;
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const moveTarget = launch?.moveTarget ?? null;
  const moveEnabled = launch?.moveEnabled ?? false;
  const commentEnabled = launch?.commentEnabled ?? settings.commentEnabled;
  const pipelineId = resolveInitialPipelineId({
    pipelineIds: pipelines.map((candidate) => candidate.id),
    requested: pipelineChoice ?? params.pipelineId,
    lastUsed,
  });
  const pipeline = pipelines.find((candidate) => candidate.id === pipelineId) ?? null;

  const mappedBaseBranch = launch?.mappedBaseBranch ?? null;
  const projectStatus = useEnvironmentQuery(
    project !== null && mappedBaseBranch === null
      ? vcsEnvironment.status({ environmentId, input: { cwd: project.workspaceRoot } })
      : null,
  );
  const baseRef = mappedBaseBranch ?? projectStatus.data?.refName ?? null;

  const text = detail ? pipelineInputText({ detail, includes, edited }) : "";
  const summary = detail ? pipelineInputSummary({ detail, text }) : null;
  const canStart = !pending && pipeline !== null && project !== null && summary?.startable === true;

  const start = async () => {
    if (!canStart || issue === null || pipeline === null || project === null) return;
    setPending(true);
    setError(null);
    const workspaceStrategy = pipelineWorkspaceStrategy({
      workspace,
      baseRef,
      branchName: issue.branchName,
    });
    const attempt = (attemptRef.current = nextPipelineStartAttempt(
      attemptRef.current,
      { pipelineId: pipeline.id, projectId: project.id, input: text, workspace: workspaceStrategy },
      uuidv4,
    ));
    const result = await startPipelineRun({
      environmentId,
      input: {
        commandId: attempt.commandId,
        pipelineId: pipeline.id,
        projectId: project.id,
        input: text,
        workspaceStrategy,
        creationSource: "mobile",
      },
    });
    if (result._tag === "Failure") {
      setPending(false);
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Failed to start the pipeline.");
      }
      return;
    }
    const run = result.value.run;
    attemptRef.current = null;
    savePreferences({ linearLastPipelineId: pipeline.id });
    // The run exists; linking it is best effort and never delays or blocks the launch.
    void recordLinearLaunch(
      pipelineLaunchRecord({
        environmentId,
        issue,
        pipelineName: pipeline.name,
        run,
        writeBack: { moveTo: moveTarget, moveEnabled, commentEnabled },
      }),
    );
    // The thread route treats a shell that has not arrived yet as an unavailable thread.
    const shellReady = await waitForThreadShell(
      { environmentId, threadId: run.parentThreadId },
      5_000,
    );
    setPending(false);
    if (shellReady) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: params.environmentId,
          threadId: String(run.parentThreadId),
        }),
      );
    } else {
      navigation.goBack();
      Dialog.alert("Pipeline started", "The run will appear in your thread list shortly.");
    }
  };

  const includeRows: ReadonlyArray<{
    readonly key: keyof LinearIssueIncludes;
    readonly label: string;
    readonly count: number;
  }> = summary
    ? [
        { key: "subIssues", label: "Sub-issues", count: summary.counts.subIssues },
        { key: "comments", label: "Comments", count: summary.counts.comments },
        { key: "linkedPrs", label: "Linked PRs", count: summary.counts.linkedPrs },
      ]
    : [];

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
        title="Run pipeline from issue"
        subtitle={issue ? `${issue.identifier} ${issue.title}` : undefined}
        onCancel={() => navigation.goBack()}
        accessibilityLabel="Cancel"
        confirm={{
          label: "Start pipeline",
          onPress: () => void start(),
          disabled: !canStart,
          loading: pending,
        }}
      />
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          contentInsetAdjustmentBehavior="automatic"
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          contentContainerClassName="px-5 pt-4 pb-6 gap-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {!canRunPipeline ? (
            <Text className="text-sm text-foreground-muted">
              This environment cannot run pipelines.
            </Text>
          ) : issue === null || detail === null ? (
            <Text className="text-sm text-foreground-muted">Loading the issue…</Text>
          ) : (
            <>
              <View className="gap-1">
                <Text className="pb-1 text-sm font-t3-medium text-foreground">Pipeline</Text>
                {pipelines.length > 0 ? null : pipelinesQuery.data === null &&
                  pipelinesQuery.error === null ? (
                  <View
                    className="min-h-12 flex-row items-center gap-2"
                    accessibilityLabel="Loading pipelines"
                    accessibilityState={{ busy: true }}
                  >
                    <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
                    <Text className="text-sm text-foreground-muted">Loading pipelines…</Text>
                  </View>
                ) : pipelinesQuery.data === null ? (
                  <Text className="text-sm text-foreground-muted">Couldn't load pipelines.</Text>
                ) : (
                  <Text className="text-sm text-foreground-muted">
                    No pipelines yet. Create one in T3 Code on your computer.
                  </Text>
                )}
                {pipelines.map((candidate) => {
                  const selected = candidate.id === pipelineId;
                  return (
                    <Pressable
                      key={candidate.id}
                      accessibilityRole="radio"
                      accessibilityLabel={candidate.name}
                      accessibilityState={{ selected }}
                      onPress={() => setPipelineChoice(candidate.id as PipelineId)}
                      className="min-h-12 flex-row items-center gap-3 border-t border-border-subtle py-2"
                    >
                      <View
                        className={cn(
                          "size-5 items-center justify-center rounded-full",
                          selected ? "bg-primary" : "border border-input-border",
                        )}
                      >
                        {selected ? (
                          <SymbolView
                            name="checkmark"
                            size={13}
                            tintColorClassName="accent-primary-foreground"
                          />
                        ) : null}
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text numberOfLines={1} className="text-sm font-t3-medium text-foreground">
                          {candidate.name}
                          {candidate.id === lastUsed ? "  ·  Last used" : ""}
                        </Text>
                        <Text className="text-xs text-foreground-muted">
                          {candidate.steps.map((step) => step.name).join(" → ")}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>

              <View className="gap-2">
                <View className="flex-row items-center justify-between gap-2">
                  <Text className="text-sm font-t3-medium text-foreground">Input</Text>
                  {edited !== null ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setEdited(null)}
                      hitSlop={12}
                    >
                      <Text className="text-sm text-primary">Reset edits</Text>
                    </Pressable>
                  ) : null}
                </View>
                <SegmentedControl
                  size="compact"
                  options={[
                    { value: "preview", label: "Preview" },
                    { value: "edit", label: "Edit" },
                  ]}
                  selected={tab}
                  onSelect={setTab}
                />
                {tab === "preview" ? (
                  <View className="max-h-64 overflow-hidden rounded-xl bg-subtle p-3">
                    <ScrollView nestedScrollEnabled>
                      <PullRequestMarkdown markdown={text} />
                    </ScrollView>
                  </View>
                ) : (
                  <TextInput
                    multiline
                    accessibilityLabel="Pipeline input"
                    value={text}
                    onChangeText={setEdited}
                    textAlignVertical="top"
                    className="max-h-64 min-h-32 rounded-xl bg-subtle px-4 py-3 text-base"
                  />
                )}
                <View className="flex-row flex-wrap items-center gap-1.5">
                  {includeRows.map((row) => (
                    <Chip
                      key={row.key}
                      size="small"
                      label={`${row.label} ${row.count}`}
                      selected={includes[row.key] && row.count > 0}
                      disabled={row.count === 0 || edited !== null}
                      accessibilityLabel={`${row.label}, ${row.count}, ${includes[row.key] ? "included" : "not included"}`}
                      onPress={() =>
                        setIncludeChoice({ ...includes, [row.key]: !includes[row.key] })
                      }
                    />
                  ))}
                </View>
                <Text
                  className={cn(
                    "text-xs",
                    summary?.overLimit ? "text-danger-text" : "text-foreground-muted",
                  )}
                >
                  {summary?.sizeLabel}
                  {" · the first step receives this as text"}
                </Text>
              </View>

              <View>
                <Menu
                  title="Project"
                  actions={projects.map((candidate) => ({
                    id: String(candidate.id),
                    title: candidate.title,
                    state: candidate.id === projectId ? ("on" as const) : ("off" as const),
                  }))}
                  onPressAction={({ nativeEvent }) => {
                    const chosen = projects.find(
                      (candidate) => String(candidate.id) === nativeEvent.event,
                    );
                    if (chosen) setProjectChoice(chosen.id);
                  }}
                >
                  <PickerRow
                    label="Project"
                    value={project?.title ?? "Choose a project"}
                    {...(projectId !== null && projectId === mappedProjectId
                      ? { hint: "from mapping" }
                      : {})}
                  />
                </Menu>
                <Menu
                  title="Workspace"
                  actions={[
                    {
                      id: "worktree",
                      title: `New worktree · ${issue.branchName}${baseRef ? ` from ${baseRef}` : ""}`,
                      state: workspace === "worktree" ? "on" : "off",
                    },
                    {
                      id: "local",
                      title: "Local checkout",
                      state: workspace === "local" ? "on" : "off",
                    },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === "worktree" || nativeEvent.event === "local") {
                      setWorkspaceChoice(nativeEvent.event);
                    }
                  }}
                >
                  <PickerRow
                    label="Workspace"
                    value={workspace === "worktree" ? "New worktree" : "Local checkout"}
                    {...(workspace === "worktree" ? { hint: issue.branchName } : {})}
                  />
                </Menu>
              </View>

              <View>
                <ToggleRow
                  title={
                    moveTarget
                      ? `Move ${issue.identifier} to ${moveTarget.name}`
                      : `Move ${issue.identifier} to a started state`
                  }
                  description={
                    moveTarget
                      ? `Currently ${issue.state.name}`
                      : `Not applicable: ${issue.identifier} is ${issue.state.name}`
                  }
                  value={moveEnabled}
                  disabled={moveTarget === null}
                  onValueChange={setMoveChoice}
                />
                <ToggleRow
                  title="Comment on the issue"
                  description="One comment with a link, updated as each step finishes"
                  value={commentEnabled}
                  onValueChange={setCommentChoice}
                />
              </View>

              {error !== null ? <Text className="text-sm text-danger-text">{error}</Text> : null}
              <Text className="text-xs text-foreground-muted">
                Steps use their own models. The run takes text only.
              </Text>
            </>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
