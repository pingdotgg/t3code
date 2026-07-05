import { useCallback } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { mapAtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  ThreadId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { threadEnvironment } from "../../state/threads";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { makeTurnCommandMetadata, type TurnCommandMetadata } from "../../lib/commandMetadata";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { randomHex } from "../../lib/uuid";
import { appSceneryStore } from "../scenery/scenery-store";
import { useAtomCommand } from "../../state/use-atom-command";
import { setPendingConnectionError } from "../../state/use-remote-environment-registry";
import { validateProjectThreadCreation } from "./projectThreadCreationValidation";

/** A reserved Dolomites scene carried by a queued task being resent. */
export interface ThreadSceneSelection {
  readonly title: string;
  readonly photoId: string | null;
}

export function useCreateProjectThread() {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  return useCallback(
    async (input: {
      readonly project: EnvironmentProject;
      readonly modelSelection: ModelSelection;
      readonly envMode: "local" | "worktree";
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly startFromOrigin?: boolean;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly initialMessageText: string;
      readonly initialAttachments: ReadonlyArray<DraftComposerImageAttachment>;
      /** Reuse identifiers from a queued pending task instead of minting new ones. */
      readonly turnMetadata?: TurnCommandMetadata;
      /**
       * Scene reserved when the task was queued. Undefined mints a fresh
       * scene from the pool; null skips scene naming entirely.
       */
      readonly scene?: ThreadSceneSelection | null;
    }) => {
      const metadata = input.turnMetadata ?? makeTurnCommandMetadata();
      const threadId = ThreadId.make(metadata.threadId);
      const initialMessageText = input.initialMessageText.trim();

      // First launch races the initial pool fetch; start() is idempotent and
      // waits for it, so early threads still get a scene name + assignment.
      let scene = input.scene ?? null;
      if (input.scene === undefined) {
        await appSceneryStore.start();
        const next = appSceneryStore.peekNextScene();
        scene = next ? { title: appSceneryStore.threadTitle(next), photoId: next.id } : null;
      }

      const validationError = validateProjectThreadCreation({
        environmentId: input.project.environmentId,
        projectId: input.project.id,
        environmentMode: input.envMode,
        branch: input.branch,
        initialMessageText,
      });
      if (validationError !== null) {
        setPendingConnectionError(validationError.message);
        return AsyncResult.failure(Cause.fail(validationError));
      }

      const result = await startTurn({
        environmentId: input.project.environmentId,
        input: buildProjectThreadStartTurnInput({
          projectId: input.project.id,
          projectCwd: input.project.workspaceRoot,
          threadId: metadata.threadId,
          commandId: metadata.commandId,
          messageId: metadata.messageId,
          createdAt: metadata.createdAt,
          text: initialMessageText,
          attachments: input.initialAttachments,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          workspaceMode: input.envMode,
          branch: input.branch,
          worktreePath: input.worktreePath,
          startFromOrigin: input.startFromOrigin ?? false,
          worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
          sceneTitle: scene?.title ?? null,
        }),
      });
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        setPendingConnectionError(
          error instanceof Error ? error.message : "The task could not be started.",
        );
        return AsyncResult.failure(result.cause);
      }
      setPendingConnectionError(null);
      if (scene?.photoId) {
        appSceneryStore.assign(
          scene.photoId,
          scopedThreadKey(input.project.environmentId, threadId),
        );
      }

      return mapAtomCommandResult(result, () =>
        scopeThreadRef(input.project.environmentId, threadId),
      );
    },
    [startTurn],
  );
}
