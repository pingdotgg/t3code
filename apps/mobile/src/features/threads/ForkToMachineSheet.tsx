import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  forkBranchState,
  forkFirstMessage,
  forkModelSelection,
} from "@t3tools/client-runtime/operations/forkToMachine";
import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { deriveLogicalProjectKeyFromSettings } from "@t3tools/client-runtime/state/project-grouping";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProject, useProjects, useServerConfigs, useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";

type ForkTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Forks a thread into a new thread on another connected machine. An agent
 * writes a handoff note from this thread, the user can edit it, and it becomes
 * the new thread's first message. Uncommitted changes stay here.
 */
export function ForkToMachineSheet({ route }: StaticScreenProps<ForkTarget>) {
  const source = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const thread = useThreadShell(scopeThreadRef(source.environmentId, source.threadId));
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const projects = useProjects();
  const groupingSettings = useMobileProjectGroupingSettings();
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  const canOperate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);

  const logicalKey = project
    ? deriveLogicalProjectKeyFromSettings(project, groupingSettings)
    : null;
  const targets = environments.flatMap((environment) => {
    if (
      environment.environmentId === source.environmentId ||
      !canCreateProjectInEnvironment(environment.connection.phase) ||
      !canOperate.has(environment.environmentId)
    )
      return [];
    const match = projects.find(
      (candidate) =>
        candidate.environmentId === environment.environmentId &&
        deriveLogicalProjectKeyFromSettings(candidate, groupingSettings) === logicalKey,
    );
    return match
      ? [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            projectId: match.id,
          },
        ]
      : [];
  });
  const [targetId, setTargetId] = useState<EnvironmentId | null>(null);
  // The choice locks once the note is written, so a lost target disables the fork.
  const target =
    targets.find((t) => t.environmentId === (targetId ?? targets[0]?.environmentId)) ?? null;
  const sourceLabel =
    environments.find((environment) => environment.environmentId === source.environmentId)?.label ??
    "another machine";

  const cwd = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const status = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({ environmentId: source.environmentId, input: { cwd } }),
  );
  const branchState = status.data ? forkBranchState(status.data) : null;

  const writeForkNote = useAtomCommand(threadEnvironment.writeForkNote, { reportFailure: false });
  const launch = useAtomCommand(threadEnvironment.launch, { reportFailure: false });
  const [message, setMessage] = useState<string | null>(null);
  // The note describes this ref; the fork starts there even if the checkout moves on.
  const [noteBaseRef, setNoteBaseRef] = useState<string | null>(null);
  const [busy, setBusy] = useState<"note" | "fork" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The note forks the latest completed turn, which includes its checkpoint.
  const isRunning = thread !== null && threadRuntimeIsActive(thread.runtime);
  const ready = thread !== null && target !== null && branchState?.kind === "ready" && !isRunning;

  const writeNote = async () => {
    if (!ready || busy) return;
    setTargetId(target.environmentId);
    setBusy("note");
    setError(null);
    const result = await writeForkNote({
      environmentId: source.environmentId,
      input: { threadId: source.threadId, targetLabel: target.label },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
      return;
    }
    setNoteBaseRef(branchState.baseRef);
    setMessage(
      forkFirstMessage({ note: result.value.note, sourceLabel, baseRef: branchState.baseRef }),
    );
  };

  const fork = async () => {
    if (!ready || busy || message === null || noteBaseRef === null || !message.trim()) return;
    const modelSelection = forkModelSelection({
      selection: thread.modelSelection,
      sourceProviders: serverConfigs.get(source.environmentId)?.providers ?? [],
      targetProviders: serverConfigs.get(target.environmentId)?.providers ?? [],
    });
    if (modelSelection === null) {
      setError(`${target.label} has no provider ready to run the thread.`);
      return;
    }
    setBusy("fork");
    setError(null);
    const threadId = ThreadId.make(uuidv4());
    const result = await launch({
      environmentId: target.environmentId,
      input: {
        commandId: CommandId.make(uuidv4()),
        creationSource: "mobile",
        threadId,
        projectId: target.projectId,
        title: thread.title,
        modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        workspaceStrategy: {
          type: "worktree",
          baseRef: noteBaseRef,
          startFromOrigin: true,
        },
        initialMessage: { messageId: MessageId.make(uuidv4()), text: message, attachments: [] },
      },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
      return;
    }
    // The new thread replaces the sheet so workspace back navigation still works.
    navigation.dispatch(
      StackActions.replace("Thread", { environmentId: target.environmentId, threadId }),
    );
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
        title="Fork to another machine"
        onCancel={() => navigation.goBack()}
        accessibilityLabel="Cancel fork"
      />
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
        <Text className="text-sm text-foreground-muted">
          Starts a new thread on another machine from this branch. An agent writes a handoff note
          from this thread first. This thread keeps going here.
        </Text>

        {targets.length === 0 ? (
          <Text className="text-sm text-foreground">
            No other connected machine has this project.
          </Text>
        ) : (
          <View>
            {targets.map((option) => (
              <Pressable
                key={option.environmentId}
                accessibilityRole="radio"
                accessibilityState={{
                  checked: option.environmentId === target?.environmentId,
                  disabled: busy !== null || message !== null,
                }}
                disabled={busy !== null || message !== null}
                onPress={() => setTargetId(option.environmentId)}
                className="flex-row items-center justify-between border-b border-border py-3.5 active:opacity-70"
              >
                <Text className="text-base font-t3-bold text-foreground">{option.label}</Text>
                {option.environmentId === target?.environmentId ? (
                  <Text className="text-sm text-foreground-muted">Selected</Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        )}

        <View className="gap-1">
          {status.error ? (
            <Text className="text-sm text-danger-foreground">{status.error}</Text>
          ) : branchState === null ? (
            <Text className="text-sm text-foreground-muted">Checking the branch…</Text>
          ) : branchState.kind === "blocked" ? (
            <Text className="text-sm text-foreground">
              {branchState.reason}
              {branchState.canPush ? " Push from the thread's git menu." : ""}
            </Text>
          ) : (
            <Text className="text-sm text-foreground-muted">
              Starts a new branch from {noteBaseRef ?? branchState.baseRef}.
            </Text>
          )}
          {status.data?.hasWorkingTreeChanges ? (
            <Text className="text-sm text-foreground-muted">
              Uncommitted changes stay on this machine.
            </Text>
          ) : null}
          {isRunning ? (
            <Text className="text-sm text-foreground-muted">
              Wait for the current turn to finish.
            </Text>
          ) : null}
        </View>

        {busy === "note" ? (
          <Text className="text-sm text-foreground-muted">
            Writing the handoff note. This takes about a minute.
          </Text>
        ) : message !== null ? (
          <View className="gap-2">
            <Text className="text-sm font-t3-medium text-foreground">First message</Text>
            <TextInput
              multiline
              accessibilityLabel="First message"
              value={message}
              onChangeText={setMessage}
              textAlignVertical="top"
              className="min-h-48 rounded-xl bg-subtle px-4 py-3 text-sm"
            />
          </View>
        ) : null}

        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}

        {message === null ? (
          <Button
            label={busy === "note" ? "Writing note…" : "Write handoff note"}
            tone="primary"
            fullWidth
            disabled={!ready || busy !== null}
            onPress={() => void writeNote()}
          />
        ) : (
          <Button
            label={busy === "fork" ? "Forking…" : `Fork to ${target?.label ?? "machine"}`}
            tone="primary"
            fullWidth
            disabled={!ready || busy !== null || message.trim().length === 0}
            onPress={() => void fork()}
          />
        )}
      </ScrollView>
    </View>
  );
}
