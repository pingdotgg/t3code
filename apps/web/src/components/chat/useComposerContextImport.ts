import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { RefObject } from "react";
import type { ChatComposerProps } from "./ChatComposer";
import {
  type ComposerContextClipboardFragment,
  type ComposerContextRecord,
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  composerTargetKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { type PendingUserInput } from "../../session-logic";
import {
  asKnownContextRecord,
  composerContextImportLookupIds,
  isSameComposerContextPayload,
  previewAnnotationContextId,
  previewAnnotationContextRecord,
  previewAnnotationFromRecord,
  reviewCommentContextId,
  reviewCommentContextRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
  terminalContextRecord,
  terminalContextReference,
} from "~/lib/composerContextRecords";
import { assetEnvironment } from "~/state/assets";
import { copiedComposerAttachmentFile } from "~/lib/copiedComposerAttachments";
import { countQuestionAttachments, questionAttachmentDraftId } from "../../questionAttachments";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import { elementContextToPreviewAnnotation } from "../../lib/elementContext";
import { orchestrationEnvironment } from "~/state/orchestration";
import { pendingDraftWork } from "./pendingDraftWork";
import { randomUUID } from "~/lib/utils";
import { readPreparedConnection } from "~/state/session";
import { resolveAssetUrl } from "~/assets/assetUrls";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import { toastManager } from "../ui/toast";
import {
  type ComposerDraftContextRecords,
  uploadedContextRecordFromDraft,
} from "../composerContextPresentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useStableCallback } from "../../hooks/useStableCallback";
import { countPreparingComposerImages } from "./preparingComposerImages";

const isUnreachable = Schema.is(
  Schema.Union([ConnectionTransientError, ConnectionBlockedError, EnvironmentRpcUnavailableError]),
);

async function downloadAttachmentBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

/**
 * Imports copied composer context (terminal output, review comments, annotations, threads,
 * images and files) into the open draft, and counts the attachment slots already spoken for.
 */
export function useComposerContextImport(input: {
  readonly environmentId: EnvironmentId;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly activeThread: ChatComposerProps["activeThread"];
  readonly activeThreadId: ChatComposerProps["activeThreadId"];
  readonly composerDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly attachmentDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly attachmentTargetKey: string;
  readonly attachmentTargetKeyRef: RefObject<string>;
  readonly questionAttachmentTarget: DraftId | null;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly composerContextRecords: ComposerDraftContextRecords;
  readonly composerImages: ReadonlyArray<ComposerImageAttachment>;
  readonly composerFilesRef: ChatComposerProps["composerFilesRef"];
  readonly promptRef: RefObject<string>;
  readonly pendingThreadImportsRef: RefObject<Map<string, number>>;
  readonly addComposerFilesToDraft: (files: ComposerFileAttachment[]) => string[];
  /** Attaches a thread's transcript to a draft, as dropping it does. */
  readonly importThreadTranscript: (
    ref: ScopedThreadRef,
    draftTarget: ChatComposerProps["composerDraftTarget"],
  ) => void;
}) {
  const {
    environmentId,
    linkedEnvironments,
    activeThread,
    activeThreadId,
    composerDraftTarget,
    attachmentDraftTarget,
    attachmentTargetKey,
    attachmentTargetKeyRef,
    questionAttachmentTarget,
    pendingUserInputs,
    composerContextRecords,
    composerImages,
    composerFilesRef,
    promptRef,
    pendingThreadImportsRef,
    addComposerFilesToDraft,
    importThreadTranscript,
  } = input;
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const addComposerDraftReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const addComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.addPreviewAnnotation,
  );
  const addComposerDraftThreadContexts = useComposerDraftStore((store) => store.addThreadContexts);
  const addComposerDraftEnvironmentContexts = useComposerDraftStore(
    (store) => store.addEnvironmentContexts,
  );
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const loadThreadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  const countReservedAttachments = (draftTarget = attachmentDraftTarget) => {
    const targetKey = composerTargetKey(draftTarget);
    const questionRequest = pendingUserInputs[0];
    const otherQuestionKeys =
      questionAttachmentTarget &&
      targetKey === attachmentTargetKey &&
      questionRequest &&
      activeThreadId
        ? questionRequest.questions
            .map((question) =>
              questionAttachmentDraftId(
                environmentId,
                activeThreadId,
                questionRequest.requestId,
                question.id,
              ),
            )
            .filter((key) => key !== questionAttachmentTarget)
        : [];
    const draft = getComposerDraft(draftTarget);
    return (
      (draft?.images.length ?? 0) +
      (draft?.files.length ?? 0) +
      countPreparingComposerImages(targetKey) +
      (pendingThreadImportsRef.current.get(targetKey) ?? 0) +
      countQuestionAttachments(otherQuestionKeys)
    );
  };
  const countReservedAttachmentsStable = useStableCallback(countReservedAttachments);
  const runAttachmentImport = async (
    record: Extract<ComposerContextRecord, { kind: "image" | "file" }>,
    localId: string,
    sourceEnvironmentId: EnvironmentId,
    importTargetKey: string,
  ) => {
    const fail = (reason: string) => {
      toastManager.add({
        type: "error",
        title: `Couldn't bring ${record.name} into this message`,
        description: `${reason} Remove the chip or attach the file again.`,
      });
    };
    let file = copiedComposerAttachmentFile(sourceEnvironmentId, record.attachmentId);
    if (!file) {
      const sourceConnection = readPreparedConnection(sourceEnvironmentId);
      if (!sourceConnection) {
        fail("The environment it came from is not connected.");
        return;
      }
      const result = await createAssetUrl({
        environmentId: sourceEnvironmentId,
        input: { resource: { _tag: "attachment", attachmentId: record.attachmentId } },
      });
      const url =
        result._tag === "Success"
          ? resolveAssetUrl(sourceConnection.httpBaseUrl, result.value.relativeUrl)
          : null;
      if (!url) {
        const cause = result._tag === "Failure" ? Cause.squash(result.cause) : null;
        fail(
          isUnreachable(cause)
            ? "The environment it came from is not reachable right now."
            : "The original attachment is no longer available.",
        );
        return;
      }
      const blob = await downloadAttachmentBlob(url);
      if (!blob) {
        fail("Downloading it from the source failed.");
        return;
      }
      // Question attachments have no inline reference; annotations can own their screenshots.
      const references = new Set(collectInlineContextIds(promptRef.current));
      if (
        !questionAttachmentTarget &&
        !references.has(toKindScopedComposerContextId(record.kind, localId)) &&
        !(
          record.kind === "image" &&
          references.has(previewAnnotationContextId(localId)) &&
          getComposerDraft(composerDraftTarget)?.previewAnnotations.some(
            (annotation) => annotation.id === localId,
          )
        )
      )
        return;
      file = new File([blob], record.name, { type: record.mimeType || blob.type });
    }
    // The draft these bytes belong to may have been sent or switched away from while they
    // downloaded. Dropping them here keeps them out of whatever draft is open now.
    if (attachmentTargetKeyRef.current !== importTargetKey) return;
    const replacesFileMarker =
      record.kind === "file" &&
      composerFilesRef.current.some(
        (candidate) =>
          composerFileNeedsReattach(candidate) &&
          composerFileMatchesReattachMarker(candidate, {
            name: record.name,
            mimeType: file.type,
            sizeBytes: file.size,
          }),
      );
    if (
      !replacesFileMarker &&
      (pendingThreadImportsRef.current.get(importTargetKey) ?? 0) > 0 &&
      countReservedAttachments() >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      fail("The attachment limit has been reached.");
      return;
    }
    if (record.kind === "image") {
      const accepted = addComposerDraftImages(
        attachmentDraftTarget,
        [
          {
            type: "image",
            id: localId,
            name: record.name,
            mimeType: file.type,
            sizeBytes: file.size,
            previewUrl: URL.createObjectURL(file),
            file,
          },
        ],
        {
          allowDuplicates:
            getComposerDraft(composerDraftTarget)?.previewAnnotations.some(
              (annotation) => annotation.id === localId,
            ) ?? false,
        },
      );
      if (!accepted.includes(localId))
        fail("The draft rejected this attachment (duplicate or attachment limit reached).");
    } else {
      const accepted = addComposerFilesToDraft([
        {
          type: "file",
          id: localId,
          name: record.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
        },
      ]);
      if (!accepted.includes(localId))
        fail("The draft rejected this attachment (duplicate or attachment limit reached).");
    }
  };
  const importAttachmentRecord = async (
    record: Extract<ComposerContextRecord, { kind: "image" | "file" }>,
    localId: string,
    sourceEnvironmentId: EnvironmentId,
  ) => {
    // The chip lands in the draft immediately while these bytes are still downloading. Count
    // the transfer against its own draft so a send cannot snapshot a message whose chip has no
    // attachment behind it, and so bytes for an abandoned draft never enter the next one.
    const importTargetKey = attachmentTargetKey;
    const contextId = toKindScopedComposerContextId(record.kind, localId);
    pendingDraftWork.begin(importTargetKey, contextId);
    await runAttachmentImport(record, localId, sourceEnvironmentId, importTargetKey).finally(() =>
      pendingDraftWork.end(importTargetKey, contextId),
    );
  };
  const importContextRecords = (
    records: ReadonlyArray<ComposerContextRecord>,
    sourceEnvironmentId: EnvironmentId | null,
    threadDraftTarget = attachmentDraftTarget,
  ): ReadonlyMap<string, string | null> => {
    // A null id means the reference becomes its plain label.
    const rewritten = new Map<string, string | null>();
    const dependentAttachmentLocalIds = new Map<string, string>();
    const skippedDependentAttachmentIds = new Set<string>();
    // Resolve annotations before their dependent screenshot records even if a foreign
    // clipboard producer emitted the records in a different order.
    const orderedRecords = records.toSorted((left, right) =>
      left.kind === "preview-annotation" && right.kind !== "preview-annotation"
        ? -1
        : right.kind === "preview-annotation" && left.kind !== "preview-annotation"
          ? 1
          : 0,
    );
    for (const candidate of orderedRecords) {
      // Producer ids fold into context ids, so two different excerpts can collide. Only skip
      // when the draft already holds the same payload; a colliding but different record is
      // re-minted under a fresh id so both survive the paste.
      const record = asKnownContextRecord(candidate);
      if (!record) continue;
      // A reminted annotation needs its screenshot under the new annotation id.
      const existingId = dependentAttachmentLocalIds.has(record.contextId)
        ? undefined
        : composerContextImportLookupIds(record).find((contextId) =>
            composerContextRecords.has(contextId),
          );
      const existing =
        existingId === undefined ? undefined : composerContextRecords.get(existingId);
      // Upload completion can change the server id since copy; the local bytes still match.
      if (
        sourceEnvironmentId !== null &&
        (record.kind === "image" || record.kind === "file") &&
        (existing?.kind === "image" || existing?.kind === "file") &&
        existing.record.file !== null &&
        existing.record.file ===
          copiedComposerAttachmentFile(sourceEnvironmentId, record.attachmentId)
      ) {
        rewritten.set(record.contextId, existingId ?? record.contextId);
        continue;
      }
      const existingRecord =
        existing?.kind === "terminal"
          ? terminalContextRecord(existing.record)
          : existing?.kind === "review-comment"
            ? reviewCommentContextRecord(existing.record)
            : existing?.kind === "preview-annotation"
              ? previewAnnotationContextRecord(existing.record, {
                  screenshotContextId: composerImages.some(
                    (image) => image.id === existing.record.id,
                  )
                    ? existing.record.id
                    : undefined,
                })
              : existing?.kind === "thread" || existing?.kind === "environment"
                ? existing.record
                : existing
                  ? (uploadedContextRecordFromDraft(existing) ?? undefined)
                  : undefined;
      if (
        existingRecord &&
        isSameComposerContextPayload(existingRecord, record) &&
        (record.kind !== "thread" || threadDraftTarget === attachmentDraftTarget)
      ) {
        if (record.kind === "preview-annotation" && record.screenshotContextId) {
          skippedDependentAttachmentIds.add(record.screenshotContextId);
        }
        // The draft may hold the record under its kind-scoped alias.
        rewritten.set(record.contextId, existingId ?? record.contextId);
        continue;
      }
      const conflicts = existing !== undefined;
      switch (record.kind) {
        case "terminal": {
          const threadId = activeThread?.id ?? activeThreadId;
          if (!threadId) break;
          const imported = terminalContextDraftFromRecord(record, threadId);
          const draft = conflicts ? { ...imported, id: randomUUID() } : imported;
          addComposerDraftTerminalContexts(composerDraftTarget, [draft], {
            appendReference: false,
          });
          rewritten.set(record.contextId, terminalContextReference(draft).contextId);
          break;
        }
        case "review-comment": {
          const imported = reviewCommentFromRecord(record);
          const comment = conflicts ? { ...imported, id: randomUUID() } : imported;
          addComposerDraftReviewComment(composerDraftTarget, comment, {
            appendReference: false,
          });
          rewritten.set(record.contextId, reviewCommentContextId(comment.id));
          break;
        }
        case "element":
        case "preview-annotation": {
          const imported =
            record.kind === "element"
              ? elementContextToPreviewAnnotation(record, randomUUID(), new Date().toISOString())
              : previewAnnotationFromRecord(record);
          const annotation = conflicts ? { ...imported, id: randomUUID() } : imported;
          if (record.kind === "preview-annotation" && record.screenshotContextId) {
            dependentAttachmentLocalIds.set(record.screenshotContextId, annotation.id);
          }
          addComposerDraftPreviewAnnotation(composerDraftTarget, annotation, {
            appendReference: false,
          });
          rewritten.set(record.contextId, previewAnnotationContextId(annotation.id));
          break;
        }
        case "thread": {
          // The agent reads threads on its own server and the machines it links to; any other
          // machine this client is connected to sends its transcript, as a dropped one does.
          if (
            record.environmentId !== environmentId &&
            !linkedEnvironments.has(record.environmentId)
          ) {
            if (!readPreparedConnection(record.environmentId)) break;
            importThreadTranscript(
              { environmentId: record.environmentId, threadId: record.threadId },
              threadDraftTarget,
            );
            rewritten.set(record.contextId, null);
            break;
          }
          addComposerDraftThreadContexts(threadDraftTarget, [record], {
            appendReference: false,
          });
          rewritten.set(record.contextId, record.contextId);
          break;
        }
        case "environment": {
          // A machine means the same machine from any thread, so a pasted one is kept,
          // but not in an answer to an agent's question, which carries no machines.
          if (questionAttachmentTarget !== null) break;
          addComposerDraftEnvironmentContexts(composerDraftTarget, [record], {
            appendReference: false,
          });
          rewritten.set(record.contextId, record.contextId);
          break;
        }
        case "image":
        case "file": {
          if (skippedDependentAttachmentIds.has(record.contextId)) break;
          if (sourceEnvironmentId === null && !conflicts) {
            rewritten.set(record.contextId, record.contextId);
            break;
          }
          if (sourceEnvironmentId === null) break;
          const localId = dependentAttachmentLocalIds.get(record.contextId) ?? randomUUID();
          rewritten.set(record.contextId, toKindScopedComposerContextId(record.kind, localId));
          void importAttachmentRecord(record, localId, sourceEnvironmentId);
          break;
        }
        default:
          break;
      }
    }
    return rewritten;
  };
  const importContextFragment = (
    fragment: ComposerContextClipboardFragment,
  ): ReadonlyMap<string, string | null> =>
    importContextRecords(fragment.records, fragment.source.environmentId);

  return {
    loadThreadTranscript,
    countReservedAttachments,
    countReservedAttachmentsStable,
    importContextRecords,
    importContextFragment,
  };
}
