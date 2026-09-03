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
import type { DraftComposerAttachment } from "../../lib/composerImages";
import { prepareTurnAttachments, validateDraftFileAttachments } from "../../lib/attachmentUpload";
import { makeTurnCommandMetadata, type TurnCommandMetadata } from "../../lib/commandMetadata";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { randomHex } from "../../lib/uuid";
import { isModelSelectionUnavailable } from "../../lib/modelOptions";
import { useAtomCommand } from "../../state/use-atom-command";
import { scheduleUnusedComposerAttachmentCleanup } from "../../state/use-composer-drafts";
import { setPendingConnectionError } from "../../state/use-remote-environment-registry";
import { validateProjectThreadCreation } from "./projectThreadCreationValidation";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { resolveProviderInteractionMode } from "./legacy-plan-mode";

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
      readonly initialAttachments: ReadonlyArray<DraftComposerAttachment>;
      readonly onAttachmentsUploaded: (
        attachments: ReadonlyArray<DraftComposerAttachment>,
      ) => Promise<void>;
      /** Reuse identifiers from a queued pending task instead of minting new ones. */
      readonly turnMetadata?: TurnCommandMetadata;
    }) => {
      const metadata = input.turnMetadata ?? makeTurnCommandMetadata();
      const threadId = ThreadId.make(metadata.threadId);
      const initialMessageText = input.initialMessageText.trim();

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

      const validateLiveFileAttachments = (
        attachments: ReadonlyArray<DraftComposerAttachment>,
      ): string | null =>
        validateDraftFileAttachments({
          attachments,
          serverConfig: appAtomRegistry.get(
            serverEnvironment.configValueAtom(input.project.environmentId),
          ),
        });
      const initialAttachmentError = validateLiveFileAttachments(input.initialAttachments);
      if (initialAttachmentError !== null) {
        setPendingConnectionError(initialAttachmentError);
        return AsyncResult.failure(Cause.fail(new Error(initialAttachmentError)));
      }

      let prepared: Awaited<ReturnType<typeof prepareTurnAttachments>>;
      try {
        // If persisting the references into the draft throws, the owner call
        // deletes the pending uploads it minted before rethrowing.
        prepared = await prepareTurnAttachments({
          environmentId: input.project.environmentId,
          attachments: input.initialAttachments,
          supportsImageUploads:
            appAtomRegistry.get(serverEnvironment.configValueAtom(input.project.environmentId))
              ?.environment.capabilities.attachmentUploads === true,
          persistUploadedReferences: async (draftAttachments) => {
            await input.onAttachmentsUploaded(draftAttachments);
            return "persisted";
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "An attachment could not upload.";
        setPendingConnectionError(message);
        return AsyncResult.failure(Cause.fail(new Error(message)));
      }
      if (prepared.status !== "ready") {
        const message = "The attachments are no longer available.";
        setPendingConnectionError(message);
        return AsyncResult.failure(Cause.fail(new Error(message)));
      }

      const preparedAttachmentError = validateLiveFileAttachments(prepared.draftAttachments);
      if (preparedAttachmentError !== null) {
        setPendingConnectionError(preparedAttachmentError);
        return AsyncResult.failure(Cause.fail(new Error(preparedAttachmentError)));
      }

      const serverConfig = appAtomRegistry.get(
        serverEnvironment.configValueAtom(input.project.environmentId),
      );
      const providerError = !serverConfig
        ? "Provider settings are still loading. Try again."
        : isModelSelectionUnavailable(serverConfig, input.modelSelection)
          ? "Antigravity model unavailable. Open model settings to finish setup or choose another model."
          : null;
      if (providerError !== null) {
        setPendingConnectionError(providerError);
        return AsyncResult.failure(Cause.fail(new Error(providerError)));
      }
      const provider = serverConfig?.providers.find(
        (candidate) => candidate.instanceId === input.modelSelection.instanceId,
      );

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
          uploadedAttachments: prepared.attachments,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: resolveProviderInteractionMode(provider, input.interactionMode),
          workspaceMode: input.envMode,
          branch: input.branch,
          worktreePath: input.worktreePath,
          startFromOrigin: input.startFromOrigin ?? false,
          worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
        }),
      });
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        setPendingConnectionError(
          error instanceof Error ? error.message : "The task could not be started.",
        );
        return AsyncResult.failure(result.cause);
      }
      // The started turn holds its own copy of the bytes; a failed delete is
      // surfaced without failing the started task.
      await prepared.releaseUploads().catch((error) => {
        console.warn("[project-thread] could not delete consumed pending uploads", error);
      });
      setPendingConnectionError(null);
      scheduleUnusedComposerAttachmentCleanup(input.initialAttachments);

      return mapAtomCommandResult(result, () =>
        scopeThreadRef(input.project.environmentId, threadId),
      );
    },
    [startTurn],
  );
}
