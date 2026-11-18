import {
  DEFAULT_VCS_TERMINOLOGY,
  JJ_WORKING_COPY_LABEL,
  JJ_WORKING_COPY_REVISION,
  type VcsTerminology,
} from "@t3tools/shared/vcs";
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
  AuthSourceControlWriteScope,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
} from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react-native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Haptics from "expo-haptics";
import { useNavigation } from "@react-navigation/native";
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
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { useSearchToolbarInset } from "../../components/ui/useBarInset";
import type { AppBarSearch } from "../../components/ui/AppBar";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";
import { filterNewTaskBranches } from "./new-task-context-presentation";
import { useDebouncedValue, usePaginatedBranches } from "../../state/queries";
import { setPendingConnectionError } from "../../state/use-remote-environment-registry";

import { useEnvironmentPresentation } from "../../state/presentation";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
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

export function NewTaskEnvironmentPickerRouteScreen() {
  const gt = useGT();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
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
      title={
        flow.vcsTerminology.systemName === "Jujutsu"
          ? flow.workspaceMode === "worktree"
            ? `Base ${flow.vcsTerminology.refNoun}`
            : flow.vcsTerminology.refNounTitle
          : flow.workspaceMode === "worktree"
            ? gt("Base branch")
            : gt("Branch")
      }
      terminology={flow.vcsTerminology}
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
      workingCopy={
        flow.canSelectWorkingCopy
          ? {
              onSelect: () => {
                flow.selectWorkingCopy();
                setBranchQuery("");
                navigation.goBack();
              },
            }
          : undefined
      }
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

export function BranchPickerScreen(props: {
  readonly terminology?: VcsTerminology;
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
  readonly workingCopy?: { readonly onSelect: () => void } | undefined;
  readonly worktree?: {
    readonly startFromOrigin: boolean;
    readonly onChangeStartFromOrigin: (value: boolean) => void;
  };
}) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const terminology = props.terminology ?? DEFAULT_VCS_TERMINOLOGY;
  const search: AppBarSearch = {
    value: props.query,
    onChangeText: props.onQueryChange,
    placeholder:
      terminology.systemName === "Jujutsu" ? `Find a ${terminology.refNoun}` : gt("Find a branch"),
    clearAccessibilityLabel:
      terminology.systemName === "Jujutsu"
        ? `Clear ${terminology.refNoun} search`
        : gt("Clear branch search"),
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

  const showWorkingCopy =
    props.workingCopy !== undefined &&
    JJ_WORKING_COPY_LABEL.toLowerCase().includes(props.query.trim().toLowerCase());
  const branchListHeader = (
    <>
      {showWorkingCopy ? (
        <View className="mb-3 overflow-hidden rounded-2xl">
          <SelectionRow
            title={JJ_WORKING_COPY_LABEL}
            selected={selectedBranchName === JJ_WORKING_COPY_REVISION}
            disabled={props.selectionDisabled}
            onPress={() => props.workingCopy?.onSelect()}
            isLast
          />
        </View>
      ) : null}
      {props.worktree && selectedBranchName !== JJ_WORKING_COPY_REVISION ? (
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
      ) : null}
    </>
  );

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
              ? terminology.systemName === "Jujutsu"
                ? `Loading ${terminology.refNounPlural}…`
                : gt("Loading branches…")
              : props.error
                ? props.error
                : props.query
                  ? terminology.systemName === "Jujutsu"
                    ? `No matching ${terminology.refNounPlural}`
                    : gt("No matching branches")
                  : terminology.systemName === "Jujutsu"
                    ? `No ${terminology.refNounPlural} available`
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
