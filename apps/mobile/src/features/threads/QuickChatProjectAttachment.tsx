import { useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { AndroidHeaderIconButton } from "../../components/AndroidScreenHeader";
import { ComposerInlineControl, ComposerToolbarScroller } from "../../components/ComposerToolbar";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { cn } from "../../lib/cn";
import type { ScopedThreadRef, VcsRef } from "@t3tools/contracts";
import { useProjects, useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import {
  prepareQuickChatWorktree,
  type PendingQuickChatAttachment,
} from "@t3tools/client-runtime/operations/quickChats";
import { quickChatAttachmentStorage } from "../../state/quick-chat-attachment-storage";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { usePaginatedBranches } from "../../state/queries";
import { BranchSelectionRow, PickerSurface, SelectionRow } from "./NewTaskContextPickerScreens";
import { uuidv4 } from "../../lib/uuid";

export function QuickChatProjectAttachment({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState<"overview" | "project" | "workspace" | "branch">("overview");
  const serverConfig = useEnvironmentServerConfig(threadRef.environmentId);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const environment = connectedEnvironments.find(
    (candidate) => candidate.environmentId === threadRef.environmentId,
  );
  const [saved] = useState(() => {
    try {
      return { pending: quickChatAttachmentStorage.load(threadRef), error: null };
    } catch {
      return {
        pending: null,
        error: "Could not load the pending attachment. Check device storage before retrying.",
      };
    }
  });
  const [projectId, setProjectId] = useState(saved.pending?.projectId ?? "");
  const [workspaceMode, setWorkspaceMode] = useState<"local" | "existing" | "new">(
    saved.pending ? "new" : "local",
  );
  const newWorktree = workspaceMode === "new";
  const [existingRef, setExistingRef] = useState<VcsRef | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const [baseBranch, setBaseBranch] = useState(saved.pending?.baseBranch ?? "");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [prepared, setPrepared] = useState<PendingQuickChatAttachment | null>(saved.pending);
  const projects = useProjects().filter(
    (project) => project.environmentId === threadRef.environmentId,
  );
  const thread = useThreadShell(threadRef);
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, "Create worktree");
  const update = useAtomCommand(threadEnvironment.updateMetadata, "Attach quick chat");
  const listRefs = useAtomQueryRunner(vcsEnvironment.readRefs, { refresh: true });
  const project = projectId ? projects.find((project) => project.id === projectId) : projects[0];
  const branchState = usePaginatedBranches({
    environmentId: threadRef.environmentId,
    cwd: page === "branch" ? (project?.workspaceRoot ?? null) : null,
    query: branchQuery,
  });
  const unavailable =
    saved.error !== null ||
    !thread ||
    thread.projectId !== null ||
    thread.archivedAt !== null ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness != null ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput;
  async function attach() {
    if (pending.current || !project || unavailable) return;
    pending.current = true;
    setBusy(true);
    try {
      let worktree = null;
      if (newWorktree) {
        const attachment = prepared ?? {
          projectId: project.id,
          workspaceRoot: project.workspaceRoot,
          baseBranch: baseBranch.trim(),
          branch: `t3/quick-chat-${uuidv4()}`,
        };
        await quickChatAttachmentStorage.save(threadRef, attachment);
        setPrepared(attachment);
        worktree = await prepareQuickChatWorktree({
          pending: attachment,
          listRefs: async () => {
            const result = await listRefs({
              environmentId: threadRef.environmentId,
              input: {
                cwd: attachment.workspaceRoot,
                query: attachment.branch,
                refKind: "local",
                refresh: true,
              },
            });
            if (result._tag === "Failure")
              throw new Error(
                "Could not check the prepared worktree. Check the connection and retry.",
              );
            return result.value;
          },
          createWorktree: async (input) => {
            const result = await createWorktree({ environmentId: threadRef.environmentId, input });
            if (result._tag === "Failure")
              throw new Error(
                "Could not confirm worktree creation. Retry to recover the same branch.",
              );
            return result.value;
          },
        });
      }
      if (workspaceMode === "existing") {
        if (!existingRef) return;
        const result = await listRefs({
          environmentId: threadRef.environmentId,
          input: {
            cwd: project.workspaceRoot,
            query: existingRef.name,
            refKind: "local",
            refresh: true,
          },
        });
        if (result._tag === "Failure")
          throw new Error("Could not check the selected worktree. Retry when connected.");
        const ref = result.value.refs.find(
          (candidate) => candidate.name === existingRef.name && !candidate.isRemote,
        );
        if (!ref?.worktreePath || ref.worktreePath === project.workspaceRoot)
          throw new Error("This worktree is no longer available. Select another worktree.");
        worktree = { refName: ref.name, path: ref.worktreePath };
      }
      const result = await update({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          projectId: project.id,
          branch: worktree?.refName ?? null,
          worktreePath: worktree?.path ?? null,
        },
      });
      if (result._tag === "Failure") {
        Alert.alert(
          "Could not confirm attachment",
          worktree
            ? `Retry to use the prepared worktree at ${worktree.path}.`
            : "Check the connection and retry.",
        );
        return;
      }
      quickChatAttachmentStorage.clear(threadRef);
      onClose();
    } catch (cause) {
      Alert.alert(
        "Could not prepare attachment",
        cause instanceof Error ? cause.message : "Check device storage and retry.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const workspaceLabel =
    workspaceMode === "local"
      ? "Local checkout"
      : newWorktree
        ? "New worktree"
        : "Existing worktree";
  const branchLabel = newWorktree
    ? baseBranch || "Base branch"
    : existingRef?.name || "Choose worktree";
  const selectionLocked = busy || prepared !== null;
  const attachDisabled =
    busy ||
    unavailable ||
    !project ||
    (newWorktree && !baseBranch.trim()) ||
    (workspaceMode === "existing" && !existingRef);
  const pageTitle =
    page === "project"
      ? "Choose project"
      : page === "workspace"
        ? "Workspace"
        : page === "branch"
          ? newWorktree
            ? "Base branch"
            : "Worktree"
          : "Attach to project";
  function goBack() {
    if (pending.current) return;
    if (page === "overview") onClose();
    else {
      setBranchQuery("");
      setPage("overview");
    }
  }
  return (
    <Modal visible animationType="none" onRequestClose={goBack}>
      <View
        className="flex-1 bg-sheet"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="min-h-16 flex-row items-center gap-3 px-4 py-2">
          <AndroidHeaderIconButton
            accessibilityLabel={page === "overview" ? "Cancel attachment" : "Back to attachment"}
            icon={page === "overview" ? "xmark" : "chevron.left"}
            disabled={busy}
            onPress={goBack}
          />
          <Text className="flex-1 text-center text-lg font-t3-bold" numberOfLines={1}>
            {pageTitle}
          </Text>
          <View className="size-11" />
        </View>
        {page === "overview" ? (
          <>
            <ScrollView
              className="flex-1"
              contentContainerClassName="grow items-center px-6 pt-12 ios:pt-[72px] pb-8"
              showsVerticalScrollIndicator={false}
            >
              <View className="w-full items-center gap-1.5">
                <Text className="text-center text-2xl font-t3-medium tracking-tight">
                  Attach this chat
                </Text>
                <View className="max-w-full flex-row items-center justify-center">
                  <Text className="text-2xl font-t3-medium tracking-tight">to </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Choose project: ${project?.title ?? "No project selected"}`}
                    disabled={selectionLocked}
                    onPress={() => setPage("project")}
                    className={cn(
                      "min-w-0 max-w-[250px] border-b border-foreground-muted active:opacity-65",
                      selectionLocked && "opacity-45",
                    )}
                  >
                    <Text className="text-2xl font-t3-medium tracking-tight" numberOfLines={1}>
                      {project?.title ?? "a project"}
                    </Text>
                  </Pressable>
                </View>
              </View>
              <View className="mt-6">
                <ComposerInlineControl
                  iconNode={
                    <EnvironmentMachineSymbol
                      kind={resolveEnvironmentMachineKind(serverConfig ?? null)}
                      size={16}
                      tintColorClassName="accent-icon-muted"
                    />
                  }
                  label={`on ${environment?.environmentLabel ?? "this environment"}`}
                  maxWidth={260}
                  showChevron={false}
                  static
                />
              </View>
              {saved.error ? (
                <Text className="mt-6 text-center text-sm text-danger-foreground">
                  {saved.error}
                </Text>
              ) : unavailable ? (
                <Text className="mt-6 text-center text-sm text-foreground-muted">
                  Finish the current turn, background work, and pending requests before attaching.
                </Text>
              ) : null}
              {projects.length === 0 && (
                <Text className="mt-6 text-center text-sm text-foreground-muted">
                  Add a project on this environment first.
                </Text>
              )}
              {prepared && !busy && (
                <View className="mt-6 items-center gap-2">
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      try {
                        quickChatAttachmentStorage.clear(threadRef);
                        setPrepared(null);
                        setProjectId("");
                        setWorkspaceMode("local");
                        setBaseBranch("");
                        setExistingRef(null);
                      } catch {
                        Alert.alert(
                          "Could not reset attachment",
                          "Check device storage and retry.",
                        );
                      }
                    }}
                    className="min-h-11 justify-center rounded-full bg-card px-4 active:opacity-70"
                  >
                    <Text className="text-sm font-t3-medium">Change attachment target</Text>
                  </Pressable>
                  <Text className="text-center text-xs text-foreground-muted">
                    Any created worktree remains available under Existing worktree.
                  </Text>
                </View>
              )}
            </ScrollView>
            <View className="bg-sheet px-4 pb-4 pt-1">
              <View className="flex-row pb-3">
                <ComposerToolbarScroller fadeSurface="sheet">
                  <ComposerInlineControl
                    icon={workspaceMode === "local" ? "folder" : "arrow.triangle.branch"}
                    label={workspaceLabel}
                    disabled={selectionLocked || !project}
                    onPress={() => setPage("workspace")}
                    maxWidth={180}
                    showChevron={false}
                  />
                  {workspaceMode !== "local" && (
                    <ComposerInlineControl
                      icon="arrow.triangle.branch"
                      label={branchLabel}
                      accessibilityLabel={`${newWorktree ? "Base branch" : "Worktree"}: ${branchLabel}`}
                      disabled={selectionLocked || !project}
                      onPress={() => {
                        setBranchQuery("");
                        setPage("branch");
                      }}
                      chevronDirection="right"
                      maxWidth={180}
                    />
                  )}
                </ComposerToolbarScroller>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: attachDisabled }}
                disabled={attachDisabled}
                onPress={() => void attach()}
                className={cn(
                  "min-h-12 items-center justify-center rounded-full bg-primary px-5 py-3 active:opacity-70",
                  attachDisabled && "opacity-45",
                )}
              >
                <Text className="text-base font-t3-medium text-primary-foreground">
                  {busy ? "Attaching…" : "Attach to project"}
                </Text>
              </Pressable>
            </View>
          </>
        ) : (
          <ScrollView
            className="flex-1"
            contentContainerClassName="px-4 pt-4 pb-8"
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {page === "project" && (
              <PickerSurface>
                {projects.map((candidate, index) => (
                  <SelectionRow
                    key={candidate.id}
                    title={candidate.title}
                    icon={
                      <ProjectFavicon
                        environmentId={candidate.environmentId}
                        projectTitle={candidate.title}
                        workspaceRoot={candidate.workspaceRoot}
                        faviconPath={candidate.faviconPath}
                        size={24}
                      />
                    }
                    selected={candidate.id === project?.id}
                    isLast={index === projects.length - 1}
                    disabled={selectionLocked}
                    onPress={() => {
                      setProjectId(candidate.id);
                      setBaseBranch("");
                      setExistingRef(null);
                      setPage("overview");
                    }}
                  />
                ))}
              </PickerSurface>
            )}
            {page === "workspace" && (
              <PickerSurface>
                {(["local", "existing", "new"] as const).map((mode, index) => (
                  <SelectionRow
                    key={mode}
                    title={
                      mode === "local"
                        ? "Local checkout"
                        : mode === "existing"
                          ? "Existing worktree"
                          : "New worktree"
                    }
                    selected={workspaceMode === mode}
                    isLast={index === 2}
                    disabled={selectionLocked}
                    onPress={() => {
                      setWorkspaceMode(mode);
                      setBranchQuery("");
                      setPage(mode === "local" ? "overview" : "branch");
                    }}
                  />
                ))}
              </PickerSurface>
            )}
            {page === "branch" && (
              <>
                <View className="mb-3">
                  <AppTextInput
                    accessibilityLabel="Search branches"
                    placeholder={newWorktree ? "Find a branch" : "Find a worktree"}
                    value={branchQuery}
                    onChangeText={setBranchQuery}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                {branchState.refs.map((ref, index) => (
                  <BranchSelectionRow
                    key={ref.name}
                    branch={ref}
                    isFirst={index === 0}
                    isLast={index === branchState.refs.length - 1}
                    badge={
                      ref.worktreePath && ref.worktreePath !== project?.workspaceRoot
                        ? "worktree"
                        : ref.current
                          ? "current"
                          : ref.isRemote
                            ? "remote"
                            : null
                    }
                    disabled={
                      selectionLocked ||
                      (!newWorktree &&
                        (!ref.worktreePath || ref.worktreePath === project?.workspaceRoot))
                    }
                    selected={
                      newWorktree ? baseBranch === ref.name : existingRef?.name === ref.name
                    }
                    onSelect={(ref) => {
                      if (newWorktree) setBaseBranch(ref.name);
                      else setExistingRef(ref);
                      setBranchQuery("");
                      setPage("overview");
                    }}
                  />
                ))}
                {branchState.isPending ? (
                  <Text className="py-6 text-center text-sm text-foreground-muted">
                    Loading branches…
                  </Text>
                ) : branchState.error ? (
                  <View className="items-center gap-3 py-6">
                    <Text className="text-center text-sm text-foreground-muted">
                      {branchState.error}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={branchState.refresh}
                      className="rounded-full bg-card px-4 py-2 active:opacity-70"
                    >
                      <Text className="text-sm font-t3-medium">Try again</Text>
                    </Pressable>
                  </View>
                ) : branchState.refs.length === 0 ? (
                  <Text className="py-6 text-center text-sm text-foreground-muted">
                    {branchQuery ? "No matching branches" : "No branches available"}
                  </Text>
                ) : null}
                {branchState.data?.nextCursor != null && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => branchState.loadNext()}
                    className="min-h-11 items-center justify-center py-3"
                  >
                    <Text className="text-sm font-t3-medium">Load more branches</Text>
                  </Pressable>
                )}
              </>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
