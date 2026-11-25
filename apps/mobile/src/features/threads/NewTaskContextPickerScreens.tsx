import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SelectionRow } from "../../components/ui/SelectionRow";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { shouldCheckoutNewTaskBranch } from "./new-task-context-presentation";
import type { VcsRef } from "@t3tools/client-runtime/state/vcs";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  repositoryGroupingDisplayNameOf,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  canCreateProjectInEnvironment,
  getCloneDirectoryName,
} from "@t3tools/client-runtime/operations/projects";
import { LegendList } from "@legendapp/list/react-native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Haptics from "expo-haptics";
import { StackActions, useNavigation } from "@react-navigation/native";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { m } from "../../i18n/messages";
import { useRef, useState, type ReactNode } from "react";
import { sanitizeNewRefName } from "@t3tools/shared/git";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useServerConfigs } from "../../state/entities";
import { isNewTaskDraftKey } from "../../state/new-task-draft-key";
import { useEnvironmentsCloningRemote } from "../../state/projectClones";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { useRefreshBranchesOnFocus } from "./use-refresh-branches-on-focus";
import { useSearchToolbarInset } from "../../components/ui/useBarInset";
import type { AppBarSearch } from "../../components/ui/AppBar";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";
import { filterNewTaskBranches } from "./new-task-context-presentation";
import { useDebouncedValue, usePaginatedBranches } from "../../state/queries";
import { setPendingConnectionError } from "../../state/use-remote-environment-registry";

import { useEnvironmentPresentation } from "../../state/presentation";
import {
  useRemoteConnectionStatus,
  useRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import {
  ConnectionDiagnosisDetails,
  useConnectionDiagnosis,
} from "../connection/ConnectionDiagnosisDetails";
import { environmentStatusText } from "../connection/environmentStatusText";

const BRANCH_SEARCH_DEBOUNCE_MS = 150;

function EnvironmentPickerRow(props: {
  environmentId: EnvironmentId;
  title: string;
  selected: boolean;
  disabled: boolean;
  isLast: boolean;
  onPress: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [expanded, setExpanded] = useState(false);
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const { diagnosis, state } = useConnectionDiagnosis(props.environmentId, presentation);
  const { onReconnectEnvironment } = useRemoteConnections();
  const connection = presentation?.connection;
  const status =
    diagnosis?.headline ??
    (connection ? environmentStatusText({ ...connection, error: null }, messages) : gt("Offline"));
  return (
    <View className={cn("bg-grouped-card", !props.isLast && "border-b border-border-subtle")}>
      <View className="flex-row items-center">
        <Pressable
          accessibilityRole="radio"
          accessibilityLabel={`${props.title}, ${status}`}
          accessibilityState={{ checked: props.selected }}
          disabled={props.disabled}
          onPress={props.onPress}
          className="min-h-16 flex-1 flex-row items-center gap-3 px-4 py-3 active:bg-subtle"
        >
          <EnvironmentMachineSymbol
            kind={resolveEnvironmentMachineKind(presentation?.serverConfig ?? null)}
            size={20}
            tintColorClassName="accent-icon-muted"
          />
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
              {props.title}
            </Text>
            <View className="flex-row items-center gap-1.5">
              <ConnectionStatusDot state={connection?.phase ?? "offline"} pulse={false} size={6} />
              <Text className="shrink text-xs text-foreground-muted" numberOfLines={2}>
                {status}
              </Text>
            </View>
          </View>
          {props.selected ? (
            <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
          ) : null}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            expanded
              ? gt("Hide connection details for {title}", { title: props.title })
              : gt("Show connection details for {title}", { title: props.title })
          }
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          className="min-h-11 min-w-11 items-center justify-center active:opacity-65"
        >
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={13}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
      </View>
      {expanded ? (
        <View className="gap-3 px-4 pb-4">
          {diagnosis ? (
            <ConnectionDiagnosisDetails hostLabel={props.title} diagnosis={diagnosis} />
          ) : (
            <Text className="text-sm text-foreground-muted">{status}</Text>
          )}
          {state.retryAt ? (
            <Text className="text-sm text-foreground-muted">
              <T>
                Next reconnect at <Var>{new Date(state.retryAt).toLocaleTimeString()}</Var>
              </T>
            </Text>
          ) : null}
          {connection?.phase !== "connected" ? (
            <Button
              label={gt("Reconnect now")}
              onPress={() => onReconnectEnvironment(props.environmentId)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ToggleRow(props: {
  readonly title: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View className="min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3">
      <Text
        className={cn(
          "min-w-0 flex-1 text-base text-foreground",
          Platform.OS !== "android" && "font-t3-medium",
        )}
        numberOfLines={1}
      >
        {props.title}
      </Text>
      <ThemedSwitch
        accessibilityLabel={props.title}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

function PickerSurface(props: { readonly children: ReactNode }) {
  return (
    <View
      className={
        Platform.OS === "android"
          ? "overflow-hidden rounded-[28px] bg-grouped-card"
          : "overflow-hidden rounded-2xl bg-grouped-card"
      }
    >
      {props.children}
    </View>
  );
}

function AddToMachineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly isLast: boolean;
  readonly onPress: () => void;
}) {
  const gt = useGT();
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Add project to {title}", { title: props.title })}
      onPress={props.onPress}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <EnvironmentMachineSymbol
        kind={resolveEnvironmentMachineKind(presentation?.serverConfig ?? null)}
        size={20}
        tintColorClassName="accent-icon-muted"
      />
      <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
        {props.title}
      </Text>
      <SymbolView name="plus" size={15} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}

function addProjectRemoteUrl(project: EnvironmentProject | null): string | null {
  const identity = project?.repositoryIdentity;
  return identity?.origin?.remoteUrl ?? identity?.locator.remoteUrl ?? null;
}

/** Connected machines without the selected repository that can clone it. */
function useAddProjectTargets() {
  const flow = useNewTaskFlow();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const serverConfigs = useServerConfigs();
  // The clone destination needs both: writing source control and creating the project.
  const canClone = useEnvironmentsWithScope(connectedEnvironments, AuthSourceControlWriteScope);
  const canOperate = useEnvironmentsWithScope(connectedEnvironments, AuthOrchestrationOperateScope);
  // A machine still cloning this repository has no repository identity yet, so `flow.environments` misses it.
  const cloning = useEnvironmentsCloningRemote(
    connectedEnvironments.map((environment) => environment.environmentId),
    addProjectRemoteUrl(flow.selectedProject),
  );
  if (flow.isScratchDraft || !flow.selectedProject?.repositoryIdentity?.locator.remoteUrl) {
    return [];
  }
  const hasProject = new Set(flow.environments.map((environment) => environment.environmentId));
  return connectedEnvironments
    .filter(
      (environment) =>
        !hasProject.has(environment.environmentId) &&
        !cloning.has(environment.environmentId) &&
        canClone.has(environment.environmentId) &&
        canOperate.has(environment.environmentId) &&
        canCreateProjectInEnvironment(environment.connectionState) &&
        serverConfigs.has(environment.environmentId),
    )
    .sort((a, b) => a.environmentLabel.localeCompare(b.environmentLabel));
}

export function NewTaskEnvironmentPickerRouteScreen() {
  const gt = useGT();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const addTargets = useAddProjectTargets();
  const addToMachine = (environmentId: EnvironmentId) => {
    const project = flow.selectedProject;
    const remoteUrl = addProjectRemoteUrl(project);
    if (!project?.repositoryIdentity || !remoteUrl) return;
    navigation.dispatch(
      StackActions.push("AddProjectDestination", {
        environmentId,
        remoteUrl,
        repositoryTitle:
          repositoryGroupingDisplayNameOf(project.repositoryIdentity) ?? project.title,
        repositoryName: getCloneDirectoryName(remoteUrl),
        projectTitle: project.title,
        // The draft moves to the clone with everything in it, as a machine switch does.
        ...(flow.draftKey !== null && isNewTaskDraftKey(flow.draftKey)
          ? { draftId: flow.draftKey }
          : flow.prompt.trim()
            ? { prompt: flow.prompt }
            : {}),
      }),
    );
  };
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <AppBar title={gt("Environment")} hideBottomBorder onBack={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 16) + 16,
            paddingHorizontal: 16,
            paddingTop: 16,
          }}
          showsVerticalScrollIndicator={false}
        >
          <PickerSurface>
            {flow.environments.map((environment, index) => (
              <EnvironmentPickerRow
                key={String(environment.environmentId)}
                environmentId={environment.environmentId}
                isLast={index === flow.environments.length - 1}
                disabled={flow.switchingToEnvironmentId !== null}
                onPress={() => {
                  void Haptics.selectionAsync();
                  void flow.switchEnvironment(environment.environmentId).then((switched) => {
                    if (switched) navigation.goBack();
                  });
                }}
                selected={flow.selectedEnvironmentId === environment.environmentId}
                title={environment.environmentLabel}
              />
            ))}
          </PickerSurface>
          {addTargets.length > 0 ? (
            <View className="mt-6 gap-2">
              <Text
                className={
                  Platform.OS === "android"
                    ? "px-4 text-sm font-t3-medium text-primary-text"
                    : "px-1 text-2xs font-t3-bold tracking-[0.7px] uppercase text-foreground-muted"
                }
              >
                {gt("Add to another machine")}
              </Text>
              <PickerSurface>
                {addTargets.map((environment, index) => (
                  <AddToMachineRow
                    key={String(environment.environmentId)}
                    environmentId={environment.environmentId}
                    title={environment.environmentLabel}
                    isLast={index === addTargets.length - 1}
                    onPress={() => addToMachine(environment.environmentId)}
                  />
                ))}
              </PickerSurface>
            </View>
          ) : null}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}

export function NewTaskBranchPickerRouteScreen() {
  const gt = useGT();
  const flow = useNewTaskFlow();
  const canWriteSourceControl = useEnvironmentScope(
    flow.selectedProject?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const navigation = useNavigation();
  const readRefs = useAtomCommand(vcsEnvironment.readRefs, { reportFailure: false });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const [switchingBranchName, setSwitchingBranchName] = useState<string | null>(null);
  const selectingBranchNameRef = useRef<string | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const branchSearchQuery = sanitizeNewRefName(branchQuery);
  const debouncedBranchQuery = useDebouncedValue(branchSearchQuery, BRANCH_SEARCH_DEBOUNCE_MS);
  const branchState = usePaginatedBranches({
    environmentId: flow.selectedProject?.environmentId ?? null,
    cwd: flow.selectedProject?.workspaceRoot || null,
    query: debouncedBranchQuery,
  });
  const branchesLoading =
    branchSearchQuery !== debouncedBranchQuery ||
    (branchState.isPending && branchState.data === null);
  const refreshBranches = () => {
    if (!flow.selectedProject) return;
    setPendingConnectionError(null);
    branchState.refresh();
  };

  const selectBranch = async (branch: VcsRef) => {
    const needsCheckout = shouldCheckoutNewTaskBranch({
      branchIsCurrent: branch.current,
      branchWorktreePath: branch.worktreePath,
      workspaceMode: flow.workspaceMode,
    });
    if (selectingBranchNameRef.current !== null || (needsCheckout && !canWriteSourceControl)) {
      return;
    }
    selectingBranchNameRef.current = branch.name;
    void Haptics.selectionAsync();

    const project = flow.selectedProject;
    if (!project) {
      selectingBranchNameRef.current = null;
      return;
    }
    setSwitchingBranchName(branch.name);
    // The guard belongs to this checkout: back actions are refused while it is
    // in flight, and our own goBack runs after it is lifted.
    const releaseRemovalGuard = navigation.addListener("beforeRemove", (event) => {
      event.preventDefault();
    });
    const result = await checkoutNewTaskBranch({
      branch,
      project,
      workspaceMode: flow.workspaceMode,
      readRefs,
      switchRef,
    }).finally(releaseRemovalGuard);
    setSwitchingBranchName(null);
    if (result._tag === "Failure") {
      selectingBranchNameRef.current = null;
      if (navigation.isFocused() && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Could not switch branch"),
          errorDisplayMessage(error, m) ?? gt("The branch could not be checked out."),
        );
      }
      return;
    }

    // Checkout already changed Git; persist the draft selection even if the sheet dismissed mid-command.
    flow.selectBranch(result.value);
    if (!navigation.isFocused()) {
      selectingBranchNameRef.current = null;
      return;
    }
    navigation.goBack();
    selectingBranchNameRef.current = null;
  };

  return (
    <BranchPickerScreen
      title={flow.workspaceMode === "worktree" ? gt("Base branch") : gt("Branch")}
      project={flow.selectedProject}
      branches={filterNewTaskBranches(branchState.refs, branchQuery)}
      selectedBranchName={
        flow.selectedBranchName ??
        flow.availableBranches.find((branch) => branch.current)?.name ??
        flow.availableBranches.find((branch) => branch.isDefault)?.name ??
        null
      }
      query={branchQuery}
      onQueryChange={setBranchQuery}
      loading={branchesLoading}
      error={branchState.error}
      refreshing={branchState.isFetchingNextPage}
      hasMore={branchState.data?.nextCursor !== null && branchState.data?.nextCursor !== undefined}
      onRefresh={refreshBranches}
      onLoadMore={branchState.loadNext}
      selectionDisabled={switchingBranchName !== null}
      onSelect={selectBranch}
      worktree={
        flow.workspaceMode === "worktree"
          ? {
              startFromOrigin: flow.startFromOrigin,
              onChangeStartFromOrigin: flow.setStartFromOrigin,
            }
          : undefined
      }
    />
  );
}

export function NewTaskRepositoriesPickerRouteScreen() {
  const gt = useGT();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const choices = flow.worktreeRepositoryChoices;
  const selection = flow.worktreeRepositorySelection;
  const selected = new Set(selection.selected);
  const toggle = (repositoryPath: string) => {
    if (choices === null) return;
    void Haptics.selectionAsync();
    flow.setWorktreeRepositories(
      choices.flatMap((choice) =>
        (choice.repositoryPath === repositoryPath) !== selected.has(choice.repositoryPath)
          ? [choice.repositoryPath]
          : [],
      ),
    );
  };
  const header =
    choices === null || choices.length === 0 ? null : (
      <View className="gap-3 pb-3">
        <Text textRole="footnote" className="px-1 text-foreground-muted">
          {selection.needsChoice
            ? gt("Choose the repositories this thread works on.")
            : gt("Each gets its own worktree on the thread's branch.")}
        </Text>
        <View className="flex-row gap-2">
          <Button
            label={gt("Select all")}
            size="compact"
            disabled={selected.size === choices.length}
            onPress={() =>
              flow.setWorktreeRepositories(choices.map((choice) => choice.repositoryPath))
            }
          />
          <Button
            label={gt("Select none")}
            size="compact"
            disabled={!selection.needsChoice && selected.size === 0}
            onPress={() => flow.setWorktreeRepositories([])}
          />
        </View>
      </View>
    );
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <AppBar title={gt("Repositories")} hideBottomBorder onBack={() => navigation.goBack()} />
      <ScreenContent>
        {choices === null || choices.length === 0 ? (
          <View className="flex-1 items-center justify-center gap-3 px-4">
            {choices === null ? <AppActivityIndicator /> : null}
            <Text className="text-center text-sm text-foreground-muted">
              {choices === null
                ? gt("Loading repositories…")
                : gt("This project tracks no repositories")}
            </Text>
          </View>
        ) : (
          <LegendList
            renderScrollComponent={NativeScrollView}
            alwaysBounceVertical={false}
            automaticallyAdjustsScrollIndicatorInsets
            className="flex-1 bg-sheet android:bg-sheet-solid"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{
              paddingBottom: Math.max(insets.bottom, 16) + 16,
              paddingHorizontal: 16,
              paddingTop: 16,
            }}
            data={choices}
            extraData={selection.selected}
            keyExtractor={(choice) => choice.repositoryPath}
            ListHeaderComponent={header}
            renderItem={({ item, index }) => (
              <SelectionRow
                icon="folder"
                role="checkbox"
                isFirst={index === 0}
                isLast={index === choices.length - 1}
                onPress={() => toggle(item.repositoryPath)}
                selected={selected.has(item.repositoryPath)}
                subtitle={
                  item.relativePath !== undefined && item.relativePath !== item.name
                    ? item.relativePath
                    : undefined
                }
                title={item.name}
              />
            )}
            showsVerticalScrollIndicator={false}
          />
        )}
      </ScreenContent>
    </View>
  );
}

export function BranchPickerScreen(props: {
  readonly title: string;
  readonly project: EnvironmentProject | null;
  readonly branches: readonly VcsRef[];
  readonly selectedBranchName: string | null;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refreshing: boolean;
  readonly hasMore: boolean;
  readonly onRefresh: () => void;
  readonly onLoadMore: () => void;
  readonly selectionDisabled?: boolean;
  readonly onSelect: (branch: VcsRef) => void;
  readonly worktree?: {
    readonly startFromOrigin: boolean;
    readonly onChangeStartFromOrigin: (value: boolean) => void;
  };
}) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  useRefreshBranchesOnFocus(props.project?.environmentId, props.project?.workspaceRoot);
  const search: AppBarSearch = {
    value: props.query,
    onChangeText: props.onQueryChange,
    placeholder: gt("Find a branch"),
    clearAccessibilityLabel: gt("Clear branch search"),
    mode: "inline",
    compactToolbar: true,
  };
  const searchToolbarInset = useSearchToolbarInset(search);
  const selectedBranchName =
    props.selectedBranchName ??
    props.branches.find((branch) => branch.current)?.name ??
    props.branches.find((branch) => branch.isDefault)?.name ??
    null;
  const branchListContentStyle = {
    paddingBottom: searchToolbarInset
      ? searchToolbarInset + 16
      : Platform.OS === "ios"
        ? 16
        : Math.max(insets.bottom, 16) + 16,
    paddingHorizontal: 16,
    paddingTop: 16,
  };

  const renderBranch = ({ item, index }: { readonly item: VcsRef; readonly index: number }) => (
    <SelectionRow
      icon="arrow.triangle.branch"
      disabled={props.selectionDisabled ?? false}
      isFirst={index === 0}
      isLast={index === props.branches.length - 1}
      onPress={() => props.onSelect(item)}
      selected={selectedBranchName === item.name}
      subtitle={branchBadgeLabel({ branch: item, project: props.project }, m)?.toUpperCase()}
      title={item.name}
    />
  );

  const branchListHeader = props.worktree ? (
    <View
      className={cn(
        "mb-3 overflow-hidden",
        Platform.OS === "android" ? "rounded-[28px]" : "rounded-2xl",
      )}
    >
      <ToggleRow
        onValueChange={props.worktree.onChangeStartFromOrigin}
        title={gt("Start from remote")}
        value={props.worktree.startFromOrigin}
      />
    </View>
  ) : null;

  const branchContent =
    props.branches.length === 0 ? (
      <ScrollView
        className="flex-1 bg-sheet android:bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16, paddingTop: 16 }}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
      >
        {branchListHeader}
        <View
          className="flex-1 items-center justify-center gap-3 px-4"
          style={{
            marginBottom: searchToolbarInset,
          }}
        >
          {props.loading ? <AppActivityIndicator /> : null}
          <Text className="text-center text-sm text-foreground-muted">
            {props.loading
              ? gt("Loading branches…")
              : props.error
                ? props.error
                : props.query
                  ? gt("No matching branches")
                  : gt("No branches available")}
          </Text>
          {!props.loading && props.error ? (
            <View className="self-center">
              <Button label={gt("Try again")} tone="secondary" onPress={props.onRefresh} />
            </View>
          ) : null}
        </View>
      </ScrollView>
    ) : (
      <LegendList
        renderScrollComponent={NativeScrollView}
        alwaysBounceVertical={false}
        automaticallyAdjustsScrollIndicatorInsets
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        className="flex-1 bg-sheet android:bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={branchListContentStyle}
        data={props.branches}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(branch) =>
          `${branch.remoteName ?? "local"}:${branch.name}:${branch.worktreePath ?? ""}`
        }
        ListHeaderComponent={branchListHeader}
        ListFooterComponent={
          props.refreshing ? (
            <View className="items-center py-4">
              <AppActivityIndicator />
            </View>
          ) : null
        }
        onEndReached={props.hasMore ? props.onLoadMore : undefined}
        onEndReachedThreshold={0.35}
        renderItem={renderBranch}
        showsVerticalScrollIndicator={false}
      />
    );

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <AppBar
        title={props.title}
        hideBottomBorder
        onBack={() => navigation.goBack()}
        search={search}
      />
      <ScreenContent>{branchContent}</ScreenContent>
    </View>
  );
}
