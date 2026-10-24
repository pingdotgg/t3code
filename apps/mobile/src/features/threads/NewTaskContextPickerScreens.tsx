import { SearchField } from "../../components/ui/SearchField";
import { Button } from "../../components/ui/Button";
import { Toolbar } from "../../components/ui/Toolbar";
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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
} from "../layout/native-mail-search-toolbar";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";

import { useEnvironmentPresentation } from "../../state/presentation";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import {
  ConnectionDiagnosisDetails,
  useConnectionDiagnosis,
} from "../connection/ConnectionDiagnosisDetails";
import { environmentStatusText } from "../connection/environmentStatusText";

function EnvironmentPickerRow(props: {
  environmentId: EnvironmentId;
  title: string;
  selected: boolean;
  disabled: boolean;
  isLast: boolean;
  onPress: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const { diagnosis, state } = useConnectionDiagnosis(props.environmentId, presentation);
  const { onReconnectEnvironment } = useRemoteConnections();
  const connection = presentation?.connection;
  const status =
    diagnosis?.headline ??
    (connection ? environmentStatusText({ ...connection, error: null }) : "Offline");
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
          accessibilityLabel={`${expanded ? "Hide" : "Show"} connection details for ${props.title}`}
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
              Next reconnect at {new Date(state.retryAt).toLocaleTimeString()}
            </Text>
          ) : null}
          {connection?.phase !== "connected" ? (
            <Button
              label="Reconnect now"
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
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: "Environment",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Environment"
          hideBottomBorder
          onBack={() => navigation.goBack()}
        />
      ) : null}
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
  const allowSelectionNavigationRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flow.setBranchQuery("");
    };
  }, [flow.setBranchQuery]);

  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (selectingBranchNameRef.current !== null && !allowSelectionNavigationRef.current) {
          event.preventDefault();
        }
      }),
    [navigation],
  );

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
    const result = await checkoutNewTaskBranch({
      branch,
      project,
      workspaceMode: flow.workspaceMode,
      readRefs,
      switchRef,
    });
    if (mountedRef.current) setSwitchingBranchName(null);
    if (result._tag === "Failure") {
      selectingBranchNameRef.current = null;
      if (mountedRef.current && navigation.isFocused() && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Could not switch branch",
          error instanceof Error ? error.message : "The branch could not be checked out.",
        );
      }
      return;
    }

    // The checkout has already changed the repository. Persist the matching
    // draft selection even if the native sheet was dismissed while the
    // command was in flight; only visible-screen work is focus-gated below.
    flow.selectBranch(result.value);
    if (!mountedRef.current || !navigation.isFocused()) {
      selectingBranchNameRef.current = null;
      return;
    }
    flow.setBranchQuery("");
    // beforeRemove blocks dismissal while a switch is in flight; this one is ours.
    allowSelectionNavigationRef.current = true;
    navigation.goBack();
    allowSelectionNavigationRef.current = false;
    selectingBranchNameRef.current = null;
  };

  return (
    <BranchPickerScreen
      title={flow.workspaceMode === "worktree" ? "Base branch" : "Branch"}
      project={flow.selectedProject}
      branches={flow.filteredBranches}
      selectedBranchName={
        flow.selectedBranchName ??
        flow.availableBranches.find((branch) => branch.current)?.name ??
        flow.availableBranches.find((branch) => branch.isDefault)?.name ??
        null
      }
      query={flow.branchQuery}
      onQueryChange={flow.setBranchQuery}
      loading={flow.branchesLoading}
      error={flow.branchesError}
      refreshing={flow.branchesFetchingNextPage}
      hasMore={flow.hasMoreBranches}
      onRefresh={flow.loadBranches}
      onLoadMore={flow.loadMoreBranches}
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
  const searchRef = useRef<import("react-native").TextInputInstance>(null);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const selectedBranchName =
    props.selectedBranchName ??
    props.branches.find((branch) => branch.current)?.name ??
    props.branches.find((branch) => branch.isDefault)?.name ??
    null;
  const branchListContentStyle = {
    paddingBottom: usesNativeMailSearchToolbar
      ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET + 16
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
      subtitle={branchBadgeLabel({ branch: item, project: props.project })?.toUpperCase()}
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
        title="Start from remote"
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
            marginBottom: usesNativeMailSearchToolbar
              ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET
              : 0,
          }}
        >
          {props.loading ? <AppActivityIndicator /> : null}
          <Text className="text-center text-sm text-foreground-muted">
            {props.loading
              ? "Loading branches…"
              : props.error
                ? props.error
                : props.query
                  ? "No matching branches"
                  : "No branches available"}
          </Text>
          {!props.loading && props.error ? (
            <View className="self-center">
              <Button label="Try again" tone="secondary" onPress={props.onRefresh} />
            </View>
          ) : null}
        </View>
      </ScrollView>
    ) : (
      <LegendList
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

  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader
          title={props.title}
          hideBottomBorder
          onBack={() => navigation.goBack()}
        />
        <View className="bg-header px-4 pb-3 pt-1">
          <SearchField
            inputRef={searchRef}
            autoFocus={false}
            accessibilityLabel="Find a branch"
            clearAccessibilityLabel="Clear branch search"
            onChangeText={props.onQueryChange}
            placeholder="Find a branch"
            value={props.query}
          />
        </View>
        <ScreenContent>{branchContent}</ScreenContent>
      </View>
    );
  }

  return (
    <>
      <NativeStackScreenOptions
        options={{
          headerShown: true,
          title: props.title,
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  onSearchTextChange: props.onQueryChange,
                  placeholder: "Find a branch",
                  searchTextChangeId: "new-task-branch-search-text",
                  showsSearchDismissButton: true,
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesNativeMailSearchToolbar
            ? undefined
            : {
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                obscureBackground: false,
                placeholder: "Find a branch",
                onChangeText: (event) => {
                  props.onQueryChange(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  props.onQueryChange("");
                },
              },
        }}
      />
      {usesNativeMailSearchToolbar ? null : (
        <Toolbar placement="bottom">
          <Toolbar.SearchBarSlot />
        </Toolbar>
      )}
      {branchContent}
    </>
  );
}
