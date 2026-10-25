import {
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadLinkedPullRequest,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useLinkedThreadPullRequest } from "../ThreadStatusIndicators";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Relink replaced closed/merged requests to the newer open request on the same branch, moving its panel. */
export function useThreadLinkedPullRequest(input: {
  readonly serverThreadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
  readonly persisted: ThreadLinkedPullRequest | null;
  readonly projectId: ProjectId | null;
  readonly projectRepository: string | null;
  readonly threadBranch: string | null;
  readonly gitStatus: VcsStatusResult | null;
}) {
  const { serverThreadRef, persisted, projectId, projectRepository, threadBranch, gitStatus } =
    input;
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const persistedStatus = useLinkedThreadPullRequest(input.environmentId, persisted);
  const detected = gitStatus?.pr;
  const replacement: ThreadLinkedPullRequest | null =
    persisted === null ||
    (persistedStatus?.pr.state !== "merged" && persistedStatus?.pr.state !== "closed") ||
    gitStatus?.refName !== threadBranch ||
    detected?.state !== "open" ||
    detected.headRef !== threadBranch ||
    projectId === null ||
    projectRepository === null ||
    (persisted.projectId === projectId &&
      persisted.repository.toLowerCase() === projectRepository.toLowerCase() &&
      persisted.number === detected.number)
      ? null
      : { projectId, repository: projectRepository, number: detected.number, url: detected.url };

  const relinkKeysRef = useRef(new Map<string, string>());
  const relinkWriteRef = useRef(Promise.resolve());
  useEffect(() => {
    if (serverThreadRef === null) return;
    const threadKey = scopedThreadKey(serverThreadRef);
    if (replacement === null) {
      relinkKeysRef.current.delete(threadKey);
      return;
    }
    const relinkKey = `${replacement.projectId}:${replacement.repository}#${replacement.number}`;
    if (relinkKeysRef.current.get(threadKey) === relinkKey) return;
    relinkKeysRef.current.set(threadKey, relinkKey);
    const openSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      serverThreadRef,
    );
    if (
      openSurface?.kind === "pull-request" &&
      persisted !== null &&
      openSurface.projectId === persisted.projectId &&
      openSurface.repository.toLowerCase() === persisted.repository.toLowerCase() &&
      openSurface.number === persisted.number
    ) {
      useRightPanelStore.getState().openPullRequest(serverThreadRef, replacement);
    }

    relinkWriteRef.current = relinkWriteRef.current.then(async () => {
      if (relinkKeysRef.current.get(threadKey) !== relinkKey) return;
      const result = await updateThreadMetadata({
        environmentId: serverThreadRef.environmentId,
        input: { threadId: serverThreadRef.threadId, linkedPullRequest: replacement },
      });
      if (relinkKeysRef.current.get(threadKey) !== relinkKey) return;
      if (result._tag !== "Failure") return;
      relinkKeysRef.current.delete(threadKey);
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to update the thread pull request",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [persisted, replacement, serverThreadRef, updateThreadMetadata]);

  const linked = replacement ?? persisted;
  return {
    linked,
    linkedKey: linked ? JSON.stringify([linked.projectId, linked.repository, linked.number]) : null,
    hasDetail: persisted !== null,
  };
}
