import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  buildStartProjectTaskInput,
  type ProjectTaskWorkspace,
} from "@t3tools/client-runtime/operations/thread-tasks";

import { toUploadChatImageAttachments, type DraftComposerImageAttachment } from "./composerImages";

export function deriveThreadTitleFromPrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "New thread";
  }

  const compact = trimmed.replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

export interface ProjectThreadStartTurnSpec {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin: boolean;
  /** Generated temp branch for worktree mode; unused for local mode. */
  readonly worktreeBranchName: string;
}

function resolveProjectTaskWorkspace(spec: ProjectThreadStartTurnSpec): ProjectTaskWorkspace {
  if (spec.workspaceMode === "local") {
    return {
      mode: "local",
      branch: spec.branch,
      worktreePath: spec.worktreePath,
    };
  }

  const baseBranch = spec.branch;
  if (baseBranch === null) {
    throw new Error("A base branch is required to create a worktree task.");
  }
  return {
    mode: "worktree",
    projectCwd: spec.projectCwd,
    baseBranch,
    worktreeBranch: spec.worktreeBranchName,
    startFromOrigin: spec.startFromOrigin,
  };
}

/**
 * Single source of the `thread.turn.start` bootstrap payload used to create a
 * thread from a project draft — shared by the immediate send path and the
 * offline outbox drain so both deliver identical commands.
 */
export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  const title = deriveThreadTitleFromPrompt(spec.text);
  return buildStartProjectTaskInput({
    commandId: CommandId.make(spec.commandId),
    threadId: ThreadId.make(spec.threadId),
    messageId: MessageId.make(spec.messageId),
    projectId: spec.projectId,
    title,
    titleSeed: title,
    text: spec.text,
    attachments: toUploadChatImageAttachments(spec.attachments),
    modelSelection: spec.modelSelection,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    createdAt: spec.createdAt,
    workspace: resolveProjectTaskWorkspace(spec),
  });
}
