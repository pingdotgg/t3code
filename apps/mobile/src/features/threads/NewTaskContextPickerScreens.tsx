import { MaterialListRow } from "../../components/MaterialListRow";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { VcsRef } from "@t3tools/client-runtime/state/vcs";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react-native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Haptics from "expo-haptics";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useServerConfigs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";

function SelectionRow(props: {
  readonly icon?: "arrow.triangle.branch" | ReactNode;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected: boolean;
  readonly isLast?: boolean;
  readonly subtitle?: string;
  readonly title: string;
}) {
  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        title={props.title}
        subtitle={props.subtitle}
        leading={
          props.icon === "arrow.triangle.branch" ? (
            <SymbolView
              name="arrow.triangle.branch"
              size={24}
              tintColorClassName="accent-icon-muted"
            />
          ) : (
            props.icon
          )
        }
        trailing={
          props.selected ? (
            <SymbolView name="checkmark" size={20} tintColorClassName="accent-focus" />
          ) : null
        }
        accessibilityRole="radio"
        accessibilityState={{ checked: props.selected }}
        disabled={props.disabled}
        onPress={props.onPress}
      />
    );
  }
  return (
    <Pressable
      accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(", ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      {props.icon === "arrow.triangle.branch" ? (
        <SymbolView
          name="arrow.triangle.branch"
          size={17}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      ) : (
        (props.icon ?? null)
      )}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function ToggleRow(props: {
  readonly title: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View className="min-h-14 flex-row items-center gap-3 bg-card px-4 py-3">
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

function BranchSelectionRow(props: {
  readonly badge: string | null;
  readonly branch: VcsRef;
  readonly disabled: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onSelect: (branch: VcsRef) => void;
  readonly selected: boolean;
}) {
  const onPress = useCallback(() => props.onSelect(props.branch), [props.branch, props.onSelect]);

  return (
    <View
      className={cn(
        props.isFirst &&
          (Platform.OS === "android"
            ? "overflow-hidden rounded-t-[28px]"
            : "overflow-hidden rounded-t-2xl"),
        props.isLast &&
          (Platform.OS === "android"
            ? "overflow-hidden rounded-b-[28px]"
            : "overflow-hidden rounded-b-2xl"),
      )}
    >
      <SelectionRow
        icon="arrow.triangle.branch"
        disabled={props.disabled}
        isLast={props.isLast}
        onPress={onPress}
        selected={props.selected}
        subtitle={props.badge ? props.badge.toUpperCase() : undefined}
        title={props.branch.name}
      />
    </View>
  );
}

function PickerSurface(props: { readonly children: ReactNode }) {
  return (
    <View
      className={
        Platform.OS === "android"
          ? "overflow-hidden rounded-[28px] bg-card"
          : "overflow-hidden rounded-2xl bg-card"
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
  const serverConfigs = useServerConfigs();

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
      <MaterialScreenContent>
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
              <SelectionRow
                key={String(environment.environmentId)}
                icon={
                  <EnvironmentMachineSymbol
                    kind={resolveEnvironmentMachineKind(
                      serverConfigs.get(environment.environmentId) ?? null,
                    )}
                    size={Platform.OS === "android" ? 24 : 17}
                    tintColorClassName="accent-icon-muted"
                  />
                }
                isLast={index === flow.environments.length - 1}
                onPress={() => {
                  void Haptics.selectionAsync();
                  flow.selectEnvironment(environment.environmentId);
                  navigation.goBack();
                }}
                selected={flow.selectedEnvironmentId === environment.environmentId}
                title={environment.environmentLabel}
              />
            ))}
          </PickerSurface>
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}

export function NewTaskBranchPickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
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

  const selectBranch = useCallback(
    async (branch: VcsRef) => {
      if (selectingBranchNameRef.current !== null) {
        return;
      }
      selectingBranchNameRef.current = branch.name;
      void Haptics.selectionAsync();

      try {
        if (!flow.selectedProject) return;
        setSwitchingBranchName(branch.name);
        const result = await checkoutNewTaskBranch({
          branch,
          project: flow.selectedProject,
          workspaceMode: flow.workspaceMode,
          switchRef,
        });
        if (result._tag === "Failure") {
          if (mountedRef.current && navigation.isFocused() && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            Alert.alert(
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
          return;
        }
        flow.setBranchQuery("");
        allowSelectionNavigationRef.current = true;
        navigation.goBack();
      } finally {
        selectingBranchNameRef.current = null;
        allowSelectionNavigationRef.current = false;
        if (mountedRef.current) {
          setSwitchingBranchName(null);
        }
      }
    },
    [
      flow.selectBranch,
      flow.selectedProject,
      flow.setBranchQuery,
      flow.workspaceMode,
      navigation,
      switchRef,
    ],
  );

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

/** The searchable branch screen shared by new threads and scheduled tasks. */
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
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const usesNativeMailSearchToolbar = Platform.OS === "ios" && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
  const selectedBranchName =
    props.selectedBranchName ??
    props.branches.find((branch) => branch.current)?.name ??
    props.branches.find((branch) => branch.isDefault)?.name ??
    null;
  const branchListContentStyle = useMemo(
    () => ({
      paddingBottom: usesNativeMailSearchToolbar
        ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET + 16
        : Platform.OS === "ios"
          ? 16
          : Math.max(insets.bottom, 16) + 16,
      paddingHorizontal: 16,
      paddingTop: 16,
    }),
    [insets.bottom, usesNativeMailSearchToolbar],
  );

  const renderBranch = useCallback(
    ({ item, index }: { readonly item: VcsRef; readonly index: number }) => (
      <BranchSelectionRow
        badge={branchBadgeLabel({ branch: item, project: props.project })}
        branch={item}
        disabled={props.selectionDisabled ?? false}
        isFirst={index === 0}
        isLast={index === props.branches.length - 1}
        onSelect={props.onSelect}
        selected={selectedBranchName === item.name}
      />
    ),
    [
      props.branches.length,
      props.project,
      props.onSelect,
      selectedBranchName,
      props.selectionDisabled,
    ],
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
        title="Start from origin"
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
          {props.loading ? <ActivityIndicator /> : null}
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
            <Pressable
              accessibilityRole="button"
              className="rounded-full bg-card px-4 py-2 active:opacity-70"
              onPress={props.onRefresh}
            >
              <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
            </Pressable>
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
              <ActivityIndicator />
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
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Find a branch"
            className="h-12 rounded-full border border-input-border bg-input px-4 font-sans text-base text-foreground"
            selectionColorClassName="accent-focus/32"
            cursorColorClassName="accent-focus"
            selectionHandleColorClassName="accent-focus"
            onChangeText={props.onQueryChange}
            placeholder="Find a branch"
            placeholderTextColorClassName="accent-placeholder"
            value={props.query}
          />
        </View>
        <MaterialScreenContent>{branchContent}</MaterialScreenContent>
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
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.SearchBarSlot />
        </NativeHeaderToolbar>
      )}
      {branchContent}
    </>
  );
}
