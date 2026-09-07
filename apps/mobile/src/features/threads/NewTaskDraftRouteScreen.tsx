import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, View } from "react-native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import { vcsEnvironment } from "../../state/vcs";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

type NewTaskDraftRouteParams = {
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly title?: string | string[];
  readonly pendingTaskId?: string | string[];
  readonly draftId?: string | string[];
  readonly incomingShareId?: string | string[];
};

export function NewTaskDraftRouteScreen({ route }: StaticScreenProps<NewTaskDraftRouteParams>) {
  const params = useMemo(() => route.params ?? {}, [route.params]);
  const pendingTaskId = Array.isArray(params.pendingTaskId)
    ? params.pendingTaskId[0]
    : params.pendingTaskId;
  const draftId = Array.isArray(params.draftId) ? params.draftId[0] : params.draftId;
  const projects = useProjects();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });

  // Keyed on the params object so a fresh navigation to this (already
  // mounted) screen produces a new reference, letting the draft screen
  // re-apply the requested project.
  const initialProjectRef = useMemo(
    () => ({
      environmentId: Array.isArray(params.environmentId)
        ? params.environmentId[0]
        : params.environmentId,
      projectId: Array.isArray(params.projectId) ? params.projectId[0] : params.projectId,
      branch: params.branch,
      worktreePath: params.worktreePath,
    }),
    [params],
  );

  const [preparation, setPreparation] = useState<{
    request: typeof initialProjectRef;
    result: Awaited<ReturnType<typeof checkoutNewTaskBranch>>;
    workspaceRoot: string | undefined;
  } | null>(null);
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === initialProjectRef.environmentId &&
      candidate.id === initialProjectRef.projectId,
  );
  const environmentId = project?.environmentId;
  const workspaceRoot = project?.workspaceRoot;
  const needsPreparation = Boolean(initialProjectRef.branch && !pendingTaskId && !draftId);

  const [pendingCheckouts, setPendingCheckouts] = useState(0);
  const checkoutTail = useRef(Promise.resolve());
  const waitingForProject =
    !project &&
    (catalogState.isLoadingConnections ||
      (!catalogState.hasLoadedShellSnapshot &&
        catalogState.hasConnectingEnvironment &&
        catalogState.connectionError === null));

  useEffect(() => {
    if (!needsPreparation || !initialProjectRef.branch || waitingForProject) return;
    const branchName = initialProjectRef.branch;
    let active = true;
    setPendingCheckouts((count) => count + 1);
    // Serialize replacements: ignoring a stale result cannot undo its Git mutation.
    checkoutTail.current = checkoutTail.current.then(async () => {
      if (!active) {
        setPendingCheckouts((count) => count - 1);
        return;
      }
      const result = await checkoutNewTaskBranch({
        // A thread's branch is historical; only switchRef can establish that
        // the shared project checkout now matches it.
        branch: {
          name: branchName,
          current: false,
          isDefault: false,
          worktreePath: initialProjectRef.worktreePath ?? null,
        },
        project: environmentId && workspaceRoot ? { environmentId, workspaceRoot } : null,
        workspaceMode: "local",
        switchRef,
      });
      setPendingCheckouts((count) => count - 1);
      if (active) setPreparation({ request: initialProjectRef, result, workspaceRoot });
    });
    return () => {
      active = false;
    };
  }, [
    environmentId,
    workspaceRoot,
    initialProjectRef,
    needsPreparation,
    switchRef,
    waitingForProject,
  ]);

  const result =
    preparation?.request === initialProjectRef && preparation.workspaceRoot === workspaceRoot
      ? preparation.result
      : null;
  // The native-stack guard covers iOS swipe dismissal as well as back actions.
  // A replaced request must settle too before the shared checkout is left behind.
  const checkoutPending = pendingCheckouts > 0 || (needsPreparation && result === null);
  usePreventRemove(checkoutPending, () => undefined);
  useEffect(() => {
    if (checkoutPending || result?._tag !== "Failure") return;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Alert.alert(
        "Could not switch branch",
        error instanceof Error ? error.message : "The branch could not be checked out.",
      );
    }
    navigation.goBack();
  }, [checkoutPending, result, navigation]);

  const preparedProjectRef = useMemo(
    () =>
      result?._tag === "Success"
        ? { ...initialProjectRef, branch: result.value.name }
        : initialProjectRef,
    [initialProjectRef, result],
  );
  // Send/queue remain unavailable on failure while the unlocked route closes.
  const preparingBranch = checkoutPending || (needsPreparation && result?._tag !== "Success");

  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: Array.isArray(params.title) ? params.title[0] : (params.title ?? "New task"),
        }}
      />
      {preparingBranch ? (
        <View className="flex-1 items-center justify-center bg-screen">
          <Text className="text-foreground">Switching branch...</Text>
        </View>
      ) : (
        <NewTaskDraftScreen
          initialProjectRef={preparedProjectRef}
          incomingShareId={
            Array.isArray(params.incomingShareId)
              ? params.incomingShareId[0]
              : params.incomingShareId
          }
          pendingTaskId={pendingTaskId}
          draftId={draftId}
        />
      )}
    </>
  );
}
