import {
  AuthOrchestrationOperateScope,
  CommandId,
  type MessageId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  deriveMessageRevertTargets,
  supportsThreadRollback,
  waitForThreadRollback,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import {
  deriveThreadRuntime,
  deriveRunlessWorkStartedAt,
} from "@t3tools/client-runtime/state/thread-execution";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import {
  assertRewindContentFits,
  prepareRewindComposerContent,
} from "../lib/composerContextClipboard";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { readEnvironmentScope } from "./session";
import { environmentThreadDetails, threadEnvironment } from "./threads";
import {
  composerContextImportsAtom,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  releaseUnusedComposerAttachmentFiles,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import { getQueuedRunEdit } from "./queued-run-edit";
import { threadOutboxManager } from "./thread-outbox";
import { rewindingThreadKeysAtom, sendingThreadKeysAtom } from "./thread-composer-operations";
import { clearThreadComposerError, setThreadComposerError } from "./thread-composer-error";

function readRewindTarget(threadRef: ScopedThreadRef, messageId: MessageId) {
  const key = scopedThreadKey(threadRef);
  const detail = appAtomRegistry.get(environmentThreadDetails.stateAtom(threadRef));
  const projection = Option.getOrNull(detail.data);
  const presentation = appAtomRegistry.get(
    environmentPresentations.presentationAtom(threadRef.environmentId),
  );
  const provider = appAtomRegistry
    .get(serverEnvironment.configValueAtom(threadRef.environmentId))
    ?.providers.find((provider) => provider.instanceId === projection?.thread.providerInstanceId);
  if (
    !projection ||
    presentation?.connection.phase !== "connected" ||
    !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
    !supportsThreadRollback(projection, provider) ||
    threadRuntimeIsActive(deriveThreadRuntime(projection)) ||
    deriveRunlessWorkStartedAt(projection) !== null ||
    appAtomRegistry.get(sendingThreadKeysAtom).has(key) ||
    getQueuedRunEdit(key) !== null ||
    appAtomRegistry.get(composerContextImportsAtom)[key] ||
    (appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[key]?.length ?? 0) > 0
  )
    return null;
  const checkpoint = deriveMessageRevertTargets(projection, {
    historyComplete: !detail.history.hasMoreHistory,
  }).get(messageId);
  const row = projection.visibleTurnItems.find(
    (row) =>
      row.visibility !== "inherited" &&
      row.item.type === "user_message" &&
      row.item.messageId === messageId,
  );
  if (!checkpoint || row?.item.type !== "user_message") return null;
  return { checkpoint, message: row.item };
}

export async function rewindUserMessage(
  threadRef: ScopedThreadRef,
  messageId: MessageId,
  confirm: () => Promise<boolean | null>,
): Promise<boolean> {
  const key = scopedThreadKey(threadRef);
  if (
    appAtomRegistry.get(rewindingThreadKeysAtom).has(key) ||
    !readRewindTarget(threadRef, messageId)
  )
    return false;
  appAtomRegistry.set(
    rewindingThreadKeysAtom,
    new Set(appAtomRegistry.get(rewindingThreadKeysAtom)).add(key),
  );
  let prepared: Awaited<ReturnType<typeof prepareRewindComposerContent>> | undefined;
  let recoverySaved = false;
  try {
    const restoreFiles = await confirm();
    if (restoreFiles === null) return false;
    const target = readRewindTarget(threadRef, messageId);
    if (!target) throw new Error("The thread has changed. Select a message to rewind again.");
    await waitForComposerDraftsLoaded();
    prepared = await prepareRewindComposerContent(
      target.message,
      threadRef.environmentId,
      getComposerDraftSnapshot(key),
      new AbortController().signal,
    );
    const currentTarget = readRewindTarget(threadRef, messageId);
    if (
      !currentTarget ||
      currentTarget.checkpoint.id !== target.checkpoint.id ||
      JSON.stringify(currentTarget.message) !== JSON.stringify(target.message)
    )
      throw new Error("The thread has changed. Select a message to rewind again.");
    assertRewindContentFits(getComposerDraftSnapshot(key), prepared);
    // A lost acknowledgement cannot tell us whether history was removed. Persist the
    // recovery copy first, so a timeout or process exit still leaves the user their prompt.
    await mergeComposerDraftContent(key, prepared, { allowAttachmentOverflow: true });
    recoverySaved = true;
    const dispatchTarget = readRewindTarget(threadRef, messageId);
    if (
      !dispatchTarget ||
      dispatchTarget.checkpoint.id !== target.checkpoint.id ||
      JSON.stringify(dispatchTarget.message) !== JSON.stringify(target.message)
    )
      throw new Error("The thread has changed. Select a message to rewind again.");
    const requestId = CommandId.make(uuidv4());
    const atom = environmentThreadDetails.stateAtom(threadRef);
    clearThreadComposerError(key);
    await waitForThreadRollback({
      readProjection: () => Option.getOrNull(appAtomRegistry.get(atom).data),
      subscribe: (inspect) => appAtomRegistry.subscribe(atom, inspect),
      requestId,
      turnCount: target.checkpoint.appRunOrdinal ?? 0,
      revert: async () => {
        const result = await runAtomCommand(
          appAtomRegistry,
          threadEnvironment.revertCheckpoint,
          {
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              commandId: requestId,
              checkpointId: target.checkpoint.id,
              scopeId: target.checkpoint.scopeId,
              turnCount: target.checkpoint.appRunOrdinal ?? 0,
              restoreFiles,
            },
          },
          { reportFailure: false },
        );
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not rewind this message.";
    setThreadComposerError(
      key,
      recoverySaved
        ? `${message} Your prompt and attachments are saved in the composer. Check the conversation before trying again.`
        : message,
    );
    return false;
  } finally {
    if (prepared) {
      try {
        await releaseUnusedComposerAttachmentFiles(prepared.attachments);
      } catch (error) {
        console.error("Could not release rewind attachments", error);
      }
    }
    const next = new Set(appAtomRegistry.get(rewindingThreadKeysAtom));
    next.delete(key);
    appAtomRegistry.set(rewindingThreadKeysAtom, next);
  }
}
