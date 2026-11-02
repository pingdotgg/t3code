import * as Dialog from "../../components/ui/Dialog";
import {
  CommonActions,
  useRoute,
  usePreventRemove,
  usePreventRemoveContext,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { AppText as Text } from "../../components/ui/AppText";
import { useProjects } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { threadSelectionDeferral } from "../layout/deferred-navigation";
import { useWorkspaceState } from "../../state/workspace";
import { vcsEnvironment } from "../../state/vcs";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";
import { resolveNewTaskBranchWorktreePath } from "./new-task-context-presentation";
import {
  type BranchCheckoutResult,
  branchCheckoutRequestKey,
  makeNewTaskBranchCheckouts,
} from "./new-task-branch-checkout";
import { liveNewTaskFlowKeys, newTaskFlowKey } from "./new-task-flow-state";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { ThreadScreenFallback } from "./ThreadScreenHost";
import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

import type { NewTaskDraftRouteParams } from "./thread-route-state";
export type { NewTaskDraftRouteParams } from "./thread-route-state";

const branchCheckouts = makeNewTaskBranchCheckouts({
  run: (request) =>
    checkoutNewTaskBranch({
      branch: {
        name: request.branch,
        current: false,
        isDefault: false,
        worktreePath: request.worktreePath,
      },
      project:
        request.environmentId !== null && request.workspaceRoot !== null
          ? { environmentId: request.environmentId, workspaceRoot: request.workspaceRoot }
          : null,
      workspaceMode: "local",
      readRefs: (input) =>
        runAtomCommand(appAtomRegistry, vcsEnvironment.readRefs, input, {
          reportFailure: false,
        }),
      switchRef: (input) =>
        runAtomCommand(appAtomRegistry, vcsEnvironment.switchRef, input, {
          reportFailure: false,
        }),
    }),
  holdNavigation: threadSelectionDeferral.waitFor,
  onFailure: (request, result) => {
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not switch branch",
        error instanceof Error ? error.message : "The branch could not be checked out.",
      );
    }
    rootNavigationRef.dispatch({
      ...CommonActions.goBack(),
      source: request.routeKey,
      target: rootNavigationRef.getRootState()?.key,
    });
  },
});

/** Abandons the branch checkouts of draft routes that left the stack. */
export function pruneNewTaskBranchCheckouts(state: Parameters<typeof liveNewTaskFlowKeys>[0]) {
  branchCheckouts.prune(liveNewTaskFlowKeys(state));
}

const idleBranchCheckoutAtom = Atom.make(AsyncResult.initial<BranchCheckoutResult, never>()).pipe(
  Atom.withLabel("mobile:new-task-branch-checkout:idle"),
);

export function NewTaskDraftRouteScreen({ route }: StaticScreenProps<NewTaskDraftRouteParams>) {
  const currentRoute = useRoute();
  const params = route.params ?? {};
  const draftId = Array.isArray(params.draftId) ? params.draftId[0] : params.draftId;
  const projects = useProjects();
  const { state: catalogState } = useWorkspaceState();

  const initialProjectRef = {
    environmentId: Array.isArray(params.environmentId)
      ? params.environmentId[0]
      : params.environmentId,
    projectId: Array.isArray(params.projectId) ? params.projectId[0] : params.projectId,
    branch: params.branch,
    worktreePath: params.worktreePath,
    cloning: (Array.isArray(params.cloning) ? params.cloning[0] : params.cloning) === "1",
  };

  const project = projects.find(
    (candidate) =>
      candidate.environmentId === initialProjectRef.environmentId &&
      candidate.id === initialProjectRef.projectId,
  );
  // A project can drop out of the list and come back while its catalog stays ready. The checkout
  // keeps the last project this route resolved, so that gap reads the same checkout.
  const [resolvedProject, setResolvedProject] = useState<Pick<
    NonNullable<typeof project>,
    "environmentId" | "workspaceRoot"
  > | null>(null);
  if (
    project &&
    (resolvedProject?.environmentId !== project.environmentId ||
      resolvedProject.workspaceRoot !== project.workspaceRoot)
  ) {
    setResolvedProject({
      environmentId: project.environmentId,
      workspaceRoot: project.workspaceRoot,
    });
  }
  const checkoutProject = project ?? resolvedProject;
  const workspaceRoot = project?.workspaceRoot;
  const needsPreparation = Boolean(initialProjectRef.branch && !draftId);
  const waitingForProject =
    !project &&
    (catalogState.isLoadingConnections ||
      (!catalogState.hasLoadedShellSnapshot &&
        catalogState.hasConnectingEnvironment &&
        catalogState.connectionError === null));

  // The checkout is keyed by its request, so a reconnect that drops and
  // restores the project reads the same checkout instead of running another.
  const flowKey = newTaskFlowKey(currentRoute);
  const checkoutKey =
    needsPreparation && initialProjectRef.branch && !waitingForProject && flowKey !== undefined
      ? branchCheckoutRequestKey({
          flowKey,
          routeKey: currentRoute.key,
          environmentId: checkoutProject?.environmentId ?? null,
          workspaceRoot: checkoutProject?.workspaceRoot ?? null,
          branch: initialProjectRef.branch,
          worktreePath: initialProjectRef.worktreePath ?? null,
        })
      : null;
  const checkout = useAtomValue(
    checkoutKey === null ? idleBranchCheckoutAtom : branchCheckouts.atom(checkoutKey),
  );
  const result = AsyncResult.isSuccess(checkout) ? checkout.value : null;
  // The native-stack guard covers iOS swipe dismissal as well as back actions.
  const checkoutPending = needsPreparation && result === null;
  usePreventRemove(checkoutPending, () => undefined);
  const { preventedRoutes } = usePreventRemoveContext();
  const removalBlocked = preventedRoutes[currentRoute.key]?.preventRemove === true;
  // Native-stack reads the provider's prevent state, which commits a render
  // after usePreventRemove updates its registry; the deferred thread selection
  // (and the failure goBack) must wait for that commit.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the branch checkout to its route once native-stack has committed the prevent-remove state
  useEffect(() => {
    if (checkoutKey === null || checkoutPending || removalBlocked) return;
    branchCheckouts.release(checkoutKey);
  }, [checkoutKey, checkoutPending, removalBlocked]);

  const prepared =
    result?._tag === "Success" && workspaceRoot
      ? {
          branch: result.value.name,
          worktreePath: resolveNewTaskBranchWorktreePath({
            workspaceMode: "local",
            projectCwd: workspaceRoot,
            branchWorktreePath: result.value.worktreePath,
          }),
        }
      : null;
  const preparedBranch = prepared ? prepared.branch : initialProjectRef.branch;
  const preparedWorktreePath = prepared ? prepared.worktreePath : initialProjectRef.worktreePath;
  // NewTaskDraftScreen re-applies the route project (and rewrites the draft's
  // workspace) whenever this object's identity changes. initialProjectRef is new
  // every render, so read its fields first: the compiler then memoizes this
  // object on them, instead of on initialProjectRef.
  const { environmentId, projectId, cloning } = initialProjectRef;
  const preparedProjectRef = {
    environmentId,
    projectId,
    branch: preparedBranch,
    worktreePath: preparedWorktreePath,
    cloning,
  };
  const preparingBranch = checkoutPending || (needsPreparation && result?._tag !== "Success");

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
          draftId={draftId}
        />
      )}
    </>
  );
}
