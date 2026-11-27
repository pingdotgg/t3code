import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  deriveAvailableRevertTurnCounts,
  deriveRevertTurnCountByUserMessageId,
  deriveThreadCheckpointSummaries,
  findRevertCheckpoint,
  waitForRevertedMessage,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import { deriveThreadRuntime } from "@t3tools/client-runtime/state/thread-execution";
import { threadRuntimeIsActive, type ThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  repositoryCheckpointScopeIds,
  rewindFileRestore,
} from "@t3tools/client-runtime/state/thread-repositories";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  remapComposerContextAttachments,
  stripAttachmentOnlyBootstrapPrompt,
} from "@t3tools/shared/composerContextReferences";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { msg, useGT } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { downloadAttachmentForPreview } from "../../lib/attachmentDownload";
import {
  createComposerFileAttachment,
  ownedComposerImageAttachment,
  persistComposerAttachmentFile,
  removePersistedComposerAttachmentFile,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import type { ThreadFeedMessage } from "../../lib/threadActivity";
import { refreshAssetUrl } from "../../state/assets";
import { appAtomRegistry } from "../../state/atom-registry";
import { hasPendingComposerDraftOperations } from "../../state/composerDraftOperations";
import { filesystemEnvironment } from "../../state/filesystem";
import { readEnvironmentScope } from "../../state/session";
import {
  clearThreadComposerError,
  setThreadComposerError,
} from "../../state/thread-composer-error";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useQuietThreadStructure, useThreadWorktreePath } from "../../state/use-thread-detail";

const rewindBusyAtom = Atom.family((_draftKey: string | null) => Atom.make(false));

function rewindTargets(projection: ThreadStructure, hasMoreHistory: boolean) {
  type Entry = Parameters<
    typeof deriveRevertTurnCountByUserMessageId
  >[0]["timelineEntries"][number];
  const entries = projection.visibleTurnItems.flatMap<Entry>((row) => {
    const item = row.item;
    switch (item.type) {
      case "user_message":
      case "assistant_message":
        return [
          {
            kind: "message",
            projectedItem: row,
            message: {
              id: item.messageId,
              role: item.type === "user_message" ? "user" : "assistant",
              runId: item.runId,
              inputIntent: item.type === "user_message" ? item.inputIntent : undefined,
            },
          },
        ];
      case "notification":
        return [
          {
            kind: "work",
            entry: { itemType: "notification", projectedItem: row, runId: item.runId },
          },
        ];
      default:
        return [];
    }
  });
  const availableRevertTurnCounts = deriveAvailableRevertTurnCounts(projection);
  const repositoryScopes = repositoryCheckpointScopeIds(projection.checkpointScopes);
  const checkpoints = deriveThreadCheckpointSummaries({
    checkpoints: projection.checkpoints.filter(
      (checkpoint) => !repositoryScopes.has(checkpoint.scopeId),
    ),
    messages: projection.messages,
  });
  return deriveRevertTurnCountByUserMessageId({
    timelineEntries: entries,
    checkpoints,
    availableRevertTurnCounts,
    threadStartCheckpointAvailable:
      !hasMoreHistory && findRevertCheckpoint(projection, 0) !== undefined,
  });
}

async function restoreRewoundMessage({
  draftKey,
  busyAtom,
  scope,
  message,
  environmentId,
  isCurrent,
  requestRewind,
  onRestore,
}: {
  readonly draftKey: string;
  readonly busyAtom: Atom.Writable<boolean>;
  readonly scope: AbortSignal;
  readonly message: ThreadFeedMessage;
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly isCurrent: () => boolean;
  readonly requestRewind: () => Promise<ReadonlyArray<string>>;
  readonly onRestore: (length: number) => void;
}) {
  if (appAtomRegistry.get(busyAtom) || scope.aborted) return;
  appAtomRegistry.set(busyAtom, true);
  clearThreadComposerError(draftKey);
  const attachments: DraftComposerAttachment[] = [];
  let rewound = false;
  try {
    await waitForComposerDraftsLoaded();
    if (hasPendingComposerDraftOperations(draftKey)) {
      throw new Error(m(msg("Wait for attachments to finish preparing before rewinding.")));
    }
    if (
      getComposerDraftSnapshot(draftKey).attachments.length + message.attachments.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      throw new Error(
        m(msg("Make room for this message's attachments in the composer before rewinding.")),
      );
    }
    for (const attachment of message.attachments) {
      if (attachment.type !== "image" && attachment.type !== "file") {
        throw new Error(m(msg("This message has an attachment that cannot be restored.")));
      }
      const url = await refreshAssetUrl(
        environmentId,
        {
          _tag: "attachment",
          attachmentId: attachment.id,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
        },
        scope,
      );
      const preview =
        url && (await downloadAttachmentForPreview({ url, attachment, signal: scope }));
      if (!preview)
        throw new Error(m(msg("Could not restore attachment: {name}", { name: attachment.name })));
      try {
        attachments.push(
          attachment.type === "image"
            ? await ownedComposerImageAttachment({
                fileUri: await persistComposerAttachmentFile(
                  preview.uri,
                  attachment.name,
                  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
                ),
                name: attachment.name,
                mimeType: attachment.mimeType,
              })
            : await createComposerFileAttachment({
                uri: preview.uri,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
              }),
        );
      } finally {
        preview.dispose();
      }
    }
    if (!isCurrent()) {
      throw new Error(m(msg("The thread has changed. Select a message to rewind again.")));
    }
    const unrestored = await requestRewind();
    rewound = true;
    const context = remapComposerContextAttachments(
      message.context,
      message.attachments,
      attachments,
    );
    await mergeComposerDraftContent(draftKey, {
      text: stripAttachmentOnlyBootstrapPrompt(message.text),
      attachments,
      ...(context ? { context } : {}),
      restoreFileReferences: true,
    });
    if (!scope.aborted) onRestore(getComposerDraftSnapshot(draftKey).text.length);
    if (unrestored.length > 0) {
      setThreadComposerError(
        draftKey,
        m(
          msg("Some repositories were not rewound: {repositories}", {
            repositories: unrestored.join(", "),
          }),
        ),
      );
    }
  } catch (error) {
    if (!scope.aborted || rewound) {
      setThreadComposerError(
        draftKey,
        errorDisplayMessage(error, m) ?? m(msg("Failed to revert thread state.")),
      );
    }
  } finally {
    if (!rewound) {
      await Promise.all(
        attachments.flatMap((attachment) =>
          attachment.fileUri ? [removePersistedComposerAttachmentFile(attachment.fileUri)] : [],
        ),
      );
    }
    appAtomRegistry.set(busyAtom, false);
  }
}

export function useThreadRewind(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly enabled: boolean;
  readonly hasMoreHistory: boolean;
  readonly threadScope: { readonly current: AbortController };
  readonly onRestore: (length: number) => void;
}) {
  const gt = useGT();
  const { threadRef } = input;
  const projection = useQuietThreadStructure(threadRef)?.projection ?? null;
  const worktreePath = useThreadWorktreePath(threadRef);
  const draftKey = threadRef ? scopedThreadKey(threadRef.environmentId, threadRef.threadId) : null;
  const busyAtom = rewindBusyAtom(draftKey);
  const busy = useAtomValue(busyAtom);
  const revertCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const readTaskFolder = useAtomQueryRunner(filesystemEnvironment.taskFolder, {
    reportFailure: false,
  });
  const targets =
    input.enabled && projection !== null && !busy
      ? rewindTargets(projection, input.hasMoreHistory)
      : undefined;

  const onRewind = (message: ThreadFeedMessage) => {
    if (threadRef === null || draftKey === null || projection === null) return;
    const turnCount = targets?.get(message.id);
    if (turnCount === undefined) return;
    const checkpoint = findRevertCheckpoint(projection, turnCount);
    if (checkpoint === undefined) return;
    const scope = input.threadScope.current.signal;
    const { environmentId, threadId } = threadRef;
    const state = environmentThreadDetails.stateAtom(threadRef);
    const readProjection = () => Option.getOrNull(appAtomRegistry.get(state).data);
    const isCurrent = () => {
      const current = readProjection();
      return (
        !scope.aborted &&
        current !== null &&
        !threadRuntimeIsActive(deriveThreadRuntime(current)) &&
        current.thread.activeProviderThreadId === projection.thread.activeProviderThreadId &&
        current.runs.at(-1)?.id === projection.runs.at(-1)?.id &&
        rewindTargets(current, input.hasMoreHistory).get(message.id) === turnCount &&
        findRevertCheckpoint(current, turnCount)?.id === checkpoint.id &&
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      );
    };
    const rewind = (restoreFiles: boolean) =>
      restoreRewoundMessage({
        draftKey,
        busyAtom,
        scope,
        message,
        environmentId,
        isCurrent,
        onRestore: input.onRestore,
        requestRewind: async () => {
          const commandId = CommandId.make(uuidv4());
          return waitForRevertedMessage(
            readProjection,
            (inspect) => appAtomRegistry.subscribe(state, inspect),
            turnCount,
            commandId,
            async () => {
              const result = await revertCheckpoint({
                environmentId,
                input: {
                  threadId,
                  commandId,
                  turnCount,
                  restoreFiles,
                  checkpointId: checkpoint.id,
                  scopeId: checkpoint.scopeId,
                },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            },
            undefined,
            m,
          );
        },
      });
    const confirm = async () => {
      const taskFolder =
        worktreePath !== null && checkpoint.status === "missing"
          ? await readTaskFolder({ environmentId, input: { worktreePath } }, { signal: scope })
          : null;
      if (scope.aborted || appAtomRegistry.get(busyAtom)) return;
      const restore =
        worktreePath === null
          ? null
          : rewindFileRestore({
              projection,
              checkpoint,
              taskFolder: taskFolder?._tag === "Success" ? taskFolder.value.taskFolder : null,
            });
      Dialog.alert(
        gt("Edit from here?"),
        restore === "repositories"
          ? gt(
              "Rewind chat to before this message. Your prompt and attachments return to the composer. Reverting repositories also undoes edits in this thread's repository worktrees.",
            )
          : restore === "files"
            ? gt(
                "Rewind chat to before this message. Your prompt and attachments return to the composer. Reverting files also undoes your own edits.",
              )
            : gt(
                "Rewind chat to before this message. Your prompt and attachments return to the composer.",
              ),
        [
          { text: gt("Cancel"), style: "cancel" },
          ...(restore === null
            ? []
            : [
                {
                  text:
                    restore === "repositories"
                      ? gt("Revert repositories too")
                      : gt("Revert files too"),
                  style: "destructive" as const,
                  onPress: () => void rewind(true),
                },
              ]),
          { text: gt("Revert and keep changes"), onPress: () => void rewind(false) },
        ],
      );
    };
    void confirm();
  };

  return { targets, onRewind, busy, isBusy: () => appAtomRegistry.get(busyAtom) };
}
