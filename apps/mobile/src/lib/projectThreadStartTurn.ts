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
} from "@t3tools/contracts";
import {
  deriveThreadTitleSeed,
  threadTitleTextFromPrompt,
} from "@t3tools/client-runtime/operations";
import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../i18n/messages";
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
  /** Tracked repositories a new worktree takes, by path; absent leaves the choice to the server. */
  readonly worktreeRepositories?: ReadonlyArray<string>;
  readonly worktreeBranchName: string;
}

export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  const title = deriveThreadTitleSeed(
    { text: spec.titleText ?? spec.text, attachments: spec.uploadedAttachments },
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
      },
      ...(isWorktree
        ? {
            prepareWorktree: {
              projectCwd: spec.projectCwd,
              // The launch needs a base ref; the server ignores it for a plain project folder.
              baseBranch: spec.branch ?? "HEAD",
              branch: spec.worktreeBranchName,
              ...(spec.startFromOrigin ? { startFromOrigin: true } : {}),
              ...(spec.worktreeRepositories === undefined
                ? {}
                : { repositories: spec.worktreeRepositories.map((path) => ({ path })) }),
            },
            runSetupScript: true,
          }
        : {}),
    },
    createdAt: spec.createdAt,
  };
}

export function deriveThreadTitleFromPrompt(value: string, resolve: MessageResolver = m): string {
  const title = threadTitleTextFromPrompt(value, resolve) || resolve(msg("New thread"));
  if (title.length <= 72) return title;
  const end = splitsSurrogatePair(title, 69) ? 68 : 69;
  return `${title.slice(0, end).trimEnd()}...`;
}

/** Titles a new task the server has not created yet; one with only attachments shows their count. */
export function deriveUnsentThreadTitle(
  input: { readonly text: string; readonly attachments: ReadonlyArray<unknown> },
  resolve: MessageResolver = m,
): string {
  if (input.text.trim().length > 0 || input.attachments.length === 0) {
    return deriveThreadTitleFromPrompt(input.text, resolve);
  }
  return resolve(
    msg("{count, plural, one {{count} attachment} other {{count} attachments}}", {
      count: input.attachments.length,
    }),
  );
}
