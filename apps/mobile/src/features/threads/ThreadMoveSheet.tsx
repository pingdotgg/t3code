import { useAtomValue } from "@effect/atom-react";
import { useNavigation, StackActions, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import {
  findMoveTargetProject,
  summarizeThreadMoveCode,
} from "@t3tools/client-runtime/thread-move";
import {
  CommandId,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type ProjectId,
  type ThreadId,
  type ThreadMoveSnapshot,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react-native";
import { useEffect, useMemo, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProject, useThreadShell } from "../../state/entities";
import { environmentProjects } from "../../state/projects";
import { threadMoveCommands, threadMoveTargetsAtom } from "../../state/threadMove";
import { useAtomCommand } from "../../state/use-atom-command";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { threadCanArchive } from "../home/threadArchive";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

const TITLE = msg("Move to another machine");
const NO_PROJECTS_ATOM = Atom.make<ReadonlyArray<OrchestrationProjectShell>>([]).pipe(
  Atom.withLabel("mobile-thread-move:no-projects"),
);

type SnapshotState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly snapshot: ThreadMoveSnapshot };

type ThreadMoveParams = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadMoveSheet({ route }: StaticScreenProps<ThreadMoveParams>) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const selectDetail = useSelectWorkspaceDetail();
  const { environmentId, threadId } = route.params;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const thread = useThreadShell(threadRef);
  const sourceProject = useProject(
    thread === null ? null : { environmentId, projectId: thread.projectId },
  );
  const targets = useAtomValue(threadMoveTargetsAtom(environmentId));
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const target =
    targets.find((candidate) => candidate.environmentId === chosenEnvironmentId) ??
    (targets.length === 1 ? targets[0]! : null);
  const targetProjects = useAtomValue(
    target === null
      ? NO_PROJECTS_ATOM
      : environmentProjects.environmentProjectsAtom(target.environmentId),
  );
  const openProjects = useMemo(
    () => targetProjects.filter((project) => project.archivedAt == null),
    [targetProjects],
  );
  const matchingProject = findMoveTargetProject(sourceProject, openProjects);
  const [chosenProjectId, setChosenProjectId] = useState<ProjectId | null>(null);
  const project =
    openProjects.find((candidate) => candidate.id === chosenProjectId) ?? matchingProject;

  const exportThread = useAtomCommand(threadMoveCommands.exportThread, { reportFailure: false });
  const moveThread = useAtomCommand(threadMoveCommands.move, { reportFailure: false });
  const [snapshotState, setSnapshotState] = useState<SnapshotState>({ status: "loading" });
  // One id per flow, so retrying after a lost reply lands on the same new thread.
  const [commandId] = useState(() => CommandId.make(uuidv4()));
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const running = thread !== null && !threadCanArchive(thread.runtime);

  const loadSnapshot = async (isCurrent: () => boolean) => {
    const result = await exportThread({ environmentId, input: { threadId } });
    if (!isCurrent()) return;
    if (result._tag === "Success") {
      setSnapshotState({ status: "ready", snapshot: result.value });
      return;
    }
    setSnapshotState({
      status: "failed",
      message:
        errorDisplayMessage(squashAtomCommandFailure(result), m) ??
        gt("This thread could not be prepared for the move."),
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- exports the thread from its environment
  useEffect(() => {
    let current = true;
    void loadSnapshot(() => current);
    return () => {
      current = false;
    };
  }, [environmentId, threadId]);

  const close = () => navigation.goBack();
  const addProject = (targetEnvironmentId: EnvironmentId) =>
    navigation.dispatch(StackActions.replace("AddProject", { environmentId: targetEnvironmentId }));

  const move = async () => {
    if (snapshotState.status !== "ready" || target === null || project === null || moving) return;
    setMoving(true);
    setMoveError(null);
    const result = await moveThread({
      commandId,
      source: { environmentId, threadId },
      target: {
        environmentId: target.environmentId,
        projectId: project.id,
        label: target.environmentLabel,
      },
      snapshot: snapshotState.snapshot,
      creationSource: "mobile",
    });
    setMoving(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setMoveError(
        errorDisplayMessage(squashAtomCommandFailure(result), m) ??
          gt("The thread could not be moved."),
      );
      return;
    }
    const outcome = result.value;
    if (outcome.sourceArchived) {
      const key = scopedThreadKey(environmentId, threadId);
      for (const kind of ["settle", "snooze", "pin"]) ThreadUndo.invalidate(kind, key);
      refreshArchivedThreadsForEnvironment(environmentId);
    } else {
      Dialog.alert(
        gt("The original thread is still open"),
        gt(
          "The thread now continues on {target}, but the original on {source} could not be archived. Archive it yourself when you no longer need it.",
          {
            target: target.environmentLabel,
            source: snapshotState.snapshot.sourceEnvironmentLabel,
          },
        ),
      );
    }
    selectDetail({
      name: "Thread",
      params: { environmentId: String(target.environmentId), threadId: String(outcome.threadId) },
    });
  };

  const code =
    snapshotState.status === "ready" ? summarizeThreadMoveCode(snapshotState.snapshot.git) : null;
  const sourceLabel =
    snapshotState.status === "ready" ? snapshotState.snapshot.sourceEnvironmentLabel : "";
  const codeLines: string[] = [];
  if (code?.type === "no-git") {
    codeLines.push(gt("This thread isn't on a Git branch, so only the conversation moves."));
  }
  if (code?.type === "carries") {
    codeLines.push(
      gt("The new thread continues on the pushed branch {branch}.", { branch: code.branch }),
    );
    if (code.unpushedCommitCount > 0) {
      codeLines.push(
        gt(
          "{count, plural, one {{count} unpushed commit stays} other {{count} unpushed commits stay}} on {environment}.",
          { count: code.unpushedCommitCount, environment: sourceLabel },
        ),
      );
    }
  }
  if (code?.type === "not-pushed") {
    codeLines.push(
      gt(
        "{branch} isn't pushed, so its commits stay on {environment}. Push it first to bring them along.",
        { branch: code.branch, environment: sourceLabel },
      ),
    );
  }
  if (code !== null && code.type !== "no-git" && code.uncommittedFileCount > 0) {
    codeLines.push(
      gt(
        "{count, plural, one {{count} uncommitted file stays} other {{count} uncommitted files stay}} on {environment}.",
        { count: code.uncommittedFileCount, environment: sourceLabel },
      ),
    );
  }
  const omittedMessageCount =
    snapshotState.status === "ready" ? snapshotState.snapshot.omittedMessageCount : 0;
  if (omittedMessageCount > 0) {
    codeLines.push(
      gt(
        "{count, plural, one {{count} older message stays} other {{count} older messages stay}} with the original thread.",
        { count: omittedMessageCount },
      ),
    );
  }

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      <View className="flex-row gap-3">
        <View className="size-10 items-center justify-center rounded-full border border-border bg-card">
          <SymbolView name="arrow.right.circle" size={18} tintColorClassName="accent-foreground" />
        </View>
        <Text className="min-w-0 flex-1 text-sm leading-normal text-foreground-secondary">
          {gt(
            "The conversation continues in a new thread on the other machine, and this one is archived. Unarchive it to bring it back.",
          )}
        </Text>
      </View>
      {targets.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          {gt("No other connected machine can take this thread right now.")}
        </Text>
      ) : null}
      {targets.length > 1 ? (
        <ListSection title={gt("Machine")}>
          {targets.map((candidate, index) => (
            <ListChoiceRow
              key={candidate.environmentId}
              label={candidate.environmentLabel}
              selected={candidate.environmentId === target?.environmentId}
              separated={index > 0}
              disabled={moving}
              onPress={() => setChosenEnvironmentId(candidate.environmentId)}
            />
          ))}
        </ListSection>
      ) : null}
      {target === null ? null : snapshotState.status === "loading" ? (
        <View className="flex-row items-center gap-3">
          <AppActivityIndicator />
          <Text className="text-sm text-foreground-muted">{gt("Preparing the thread…")}</Text>
        </View>
      ) : snapshotState.status === "failed" ? (
        <View className="gap-3">
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {snapshotState.message}
          </Text>
          <Button
            label={gt("Try again")}
            fullWidth
            onPress={() => {
              setSnapshotState({ status: "loading" });
              void loadSnapshot(() => true);
            }}
          />
        </View>
      ) : (
        <>
          <ListSection
            title={gt("Project on {environment}", { environment: target.environmentLabel })}
            {...(matchingProject === null
              ? {
                  footer:
                    openProjects.length === 0
                      ? gt(
                          "{environment} has no projects yet. Add this repository there first, then move the thread.",
                          { environment: target.environmentLabel },
                        )
                      : gt(
                          "No project on {environment} matches this thread's repository. Choose one, or add the repository there first.",
                          { environment: target.environmentLabel },
                        ),
                }
              : {})}
          >
            {openProjects.map((candidate, index) => (
              <ListChoiceRow
                key={candidate.id}
                label={candidate.title}
                description={candidate.workspaceRoot}
                selected={candidate.id === project?.id}
                separated={index > 0}
                disabled={moving}
                onPress={() => setChosenProjectId(candidate.id)}
              />
            ))}
            {matchingProject === null ? (
              <View className={openProjects.length > 0 ? "border-t border-border-subtle" : ""}>
                <ListActionRow
                  icon="folder.badge.plus"
                  label={gt("Add a project on {environment}", {
                    environment: target.environmentLabel,
                  })}
                  disabled={moving}
                  onPress={() => addProject(target.environmentId)}
                />
              </View>
            ) : null}
          </ListSection>
          {codeLines.length > 0 ? (
            <View className="gap-1.5">
              {codeLines.map((line) => (
                <Text key={line} className="text-sm text-foreground">
                  {line}
                </Text>
              ))}
            </View>
          ) : null}
          {running ? (
            <Text className="text-sm text-foreground-muted">
              {gt("This thread is working. Interrupt it first, then move it.")}
            </Text>
          ) : null}
          {moveError !== null ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {moveError}
            </Text>
          ) : null}
          <Button
            label={
              moving
                ? gt("Moving…")
                : gt("Move", { $context: "verb, confirms moving a thread to another machine" })
            }
            tone="primary"
            fullWidth
            loading={moving}
            disabled={project === null || running}
            onPress={() => void move()}
          />
        </>
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader
          presentation="native"
          title={m(TITLE)}
          onClose={close}
          dismissDisabled={moving}
        />
        {content}
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-header">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AppBar sheet title={m(TITLE)} hideBottomBorder onBack={close} />
      <ScreenContent>{content}</ScreenContent>
    </View>
  );
}
