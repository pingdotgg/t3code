import {
  CommandId,
  MessageId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationMessageContext,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@lathe/contracts";
import { deriveThreadTitleSeed, threadTitleTextFromPrompt } from "@lathe/client-runtime/operations";
import { msg } from "gt-react-native";

import { m } from "../i18n/messages";
import type { UploadedMobileAttachment } from "./attachmentUpload";

export interface ProjectThreadStartTurnSpec {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly titleText?: string;
  readonly context?: OrchestrationMessageContext;
  readonly uploadedAttachments: ReadonlyArray<UploadedMobileAttachment | ChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin: boolean;
  readonly worktreeBranchName: string;
  /** The thread this one continues, recorded on the created thread. */
  readonly continuedFromThreadId?: ThreadId | undefined;
}

export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  // The link rides only while the message still carries the source's chip, so
  // removing the chip also drops the new agent's read grant.
  const continuationSource = spec.continuedFromThreadId
    ? spec.context?.records.flatMap((record) =>
        !("payload" in record) &&
        record.kind === "thread" &&
        record.threadId === spec.continuedFromThreadId
          ? [record]
          : [],
      )[0]
    : undefined;
  const title = deriveThreadTitleSeed(
    {
      text: continuationSource
        ? m(msg("Continue: {title}", { title: continuationSource.title }))
        : (spec.titleText ?? spec.text),
      attachments: spec.uploadedAttachments,
    },
    m,
  );
  const isWorktree = spec.workspaceMode === "worktree";
  return {
    commandId: CommandId.make(spec.commandId),
    creationSource: "mobile" as const,
    threadId: ThreadId.make(spec.threadId),
    message: {
      messageId: MessageId.make(spec.messageId),
      role: "user" as const,
      text: spec.text,
      ...(spec.context ? { context: spec.context } : {}),
      attachments: spec.uploadedAttachments,
    },
    modelSelection: spec.modelSelection,
    titleSeed: title,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    bootstrap: {
      createThread: {
        projectId: spec.projectId,
        title,
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.branch,
        worktreePath: isWorktree ? null : spec.worktreePath,
        createdAt: spec.createdAt,
        ...(continuationSource ? { continuedFromThreadId: spec.continuedFromThreadId } : {}),
      },
      ...(isWorktree
        ? {
            prepareWorktree: {
              projectCwd: spec.projectCwd,
              baseBranch: spec.branch!,
              branch: spec.worktreeBranchName,
              ...(spec.startFromOrigin ? { startFromOrigin: true } : {}),
            },
            runSetupScript: true,
          }
        : {}),
    },
    createdAt: spec.createdAt,
  };
}

export function deriveThreadTitleFromPrompt(value: string): string {
  const title = threadTitleTextFromPrompt(value, m) || m(msg("New thread"));
  return title.length <= 72 ? title : `${title.slice(0, 69).trimEnd()}...`;
}
