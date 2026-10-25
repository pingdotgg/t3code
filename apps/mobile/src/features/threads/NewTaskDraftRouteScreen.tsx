import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useNewTaskFlow } from "./new-task-flow-provider";
import * as Dialog from "../../components/ui/Dialog";
import {
  useNavigation,
  useRoute,
  usePreventRemove,
  usePreventRemoveContext,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/ui/AppText";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import { vcsEnvironment } from "../../state/vcs";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";
import { resolveNewTaskBranchWorktreePath } from "./new-task-context-presentation";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { ThreadScreenFallback } from "./ThreadScreenHost";
import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

import type { NewTaskDraftRouteParams } from "./thread-route-state";
export type { NewTaskDraftRouteParams } from "./thread-route-state";

export function NewTaskDraftRouteScreen({ route }: StaticScreenProps<NewTaskDraftRouteParams>) {
  const currentRoute = useRoute();
  const params = useMemo(() => route.params ?? {}, [route.params]);
  const { reset } = useNewTaskFlow();
  const { deferThreadSelectionUntil } = useAdaptiveWorkspaceLayout();
  const [initialized, setInitialized] = useState(false);
  useLayoutEffect(() => {
    reset();
    setInitialized(true);
  }, [reset]);
  const pendingTaskId = Array.isArray(params.pendingTaskId)
    ? params.pendingTaskId[0]
    : params.pendingTaskId;
  const draftId = Array.isArray(params.draftId) ? params.draftId[0] : params.draftId;
  const projects = useProjects();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const readRefs = useAtomCommand(vcsEnvironment.readRefs, { reportFailure: false });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });

  const initialProjectRef = useMemo(
    () => ({
      environmentId: Array.isArray(params.environmentId)
        ? params.environmentId[0]
        : params.environmentId,
      projectId: Array.isArray(params.projectId) ? params.projectId[0] : params.projectId,
      branch: params.branch,
      worktreePath: params.worktreePath,
      cloning: (Array.isArray(params.cloning) ? params.cloning[0] : params.cloning) === "1",
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
  const committedCheckoutReleases = useRef(new Set<() => void>());
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
        branch: {
          name: branchName,
          current: false,
          isDefault: false,
          worktreePath: initialProjectRef.worktreePath ?? null,
        },
        project: environmentId && workspaceRoot ? { environmentId, workspaceRoot } : null,
        workspaceMode: "local",
        readRefs,
        switchRef,
      });
      setPendingCheckouts((count) => count - 1);
      if (active) setPreparation({ request: initialProjectRef, result, workspaceRoot });
    });
    const committed = Promise.withResolvers<void>();
    committedCheckoutReleases.current.add(committed.resolve);
    deferThreadSelectionUntil(Promise.allSettled([checkoutTail.current, committed.promise]));
    return () => {
      active = false;
    };
  }, [
    deferThreadSelectionUntil,
    environmentId,
    workspaceRoot,
    initialProjectRef,
    needsPreparation,
    readRefs,
    switchRef,
    waitingForProject,
  ]);

  const result =
    preparation?.request === initialProjectRef && preparation.workspaceRoot === workspaceRoot
      ? preparation.result
      : null;
  // Guard native swipes too; replaced checkout requests must settle before leaving the shared checkout.
  const checkoutPending = pendingCheckouts > 0 || (needsPreparation && result === null);
  usePreventRemove(checkoutPending, () => undefined);
  const { preventedRoutes } = usePreventRemoveContext();
  const removalBlocked = preventedRoutes[currentRoute.key]?.preventRemove === true;
  useEffect(() => {
    if (checkoutPending || removalBlocked) return;
    // Native-stack reads the provider state, which commits after the hook updates its registry.
    for (const release of committedCheckoutReleases.current) release();
    committedCheckoutReleases.current.clear();
  }, [checkoutPending, removalBlocked]);
  useEffect(() => {
    const releases = committedCheckoutReleases.current;
    return () => {
      for (const release of releases) release();
      releases.clear();
    };
  }, []);
  useEffect(() => {
    if (checkoutPending || result?._tag !== "Failure") return;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not switch branch",
        error instanceof Error ? error.message : "The branch could not be checked out.",
      );
    }
    navigation.goBack();
  }, [checkoutPending, result, navigation]);

  const preparedProjectRef = useMemo(
    () =>
      result?._tag === "Success" && workspaceRoot
        ? {
            ...initialProjectRef,
            branch: result.value.name,
            worktreePath: resolveNewTaskBranchWorktreePath({
              workspaceMode: "local",
              projectCwd: workspaceRoot,
              branchWorktreePath: result.value.worktreePath,
            }),
          }
        : initialProjectRef,
    [initialProjectRef, result, workspaceRoot],
  );
  const preparingBranch = checkoutPending || (needsPreparation && result?._tag !== "Success");

  if (!initialized) return null;
  return (
    <>
      {preparingBranch ? (
        <ThreadScreenFallback>
          <NativeStackScreenOptions options={{ title: "New thread" }} />
          <View className="flex-1 items-center justify-center bg-screen">
            <Text className="text-foreground">Switching branch...</Text>
          </View>
        </ThreadScreenFallback>
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
