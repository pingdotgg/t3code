import type {
  EnvironmentId,
  ThreadContextRecord,
  ThreadMoveInput,
  ThreadMoveResult,
} from "@t3tools/contracts";
import { collectInlineContextIds } from "../../lib/composerContextReferences";

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "Checking machine resources",
      description: "Resource checks are still running. You can choose a machine in the composer.",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "Choose a machine to continue",
    description: noMachineReadsEveryThread
      ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
      : "No eligible machine has available resources. Choose a machine in the composer to override.",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Approval declined. Your message changed, so it wasn't sent."
      : "Your message changed, so it wasn't sent.";
  }
  if (input.approvalResponding) {
    return "An approval is already being answered, so your message wasn't sent.";
  }
  if (input.declined && input.approvalArrived) {
    return "Another approval arrived, so your message wasn't sent.";
  }
  return null;
}

/*
 * Why a move cannot happen, as full sentences: a toast, a pane hint, and a pane footer show
 * them as they are. A slash menu row shows one through `slashMenuRowText`.
 */
const DRAFT_CHOOSES_PROJECT =
  "Press Esc, then pick the project in the heading above the composer before the first message.";
const QUEUED_EDIT_OPEN = "Save or cancel the queued message edit first.";
const REQUEST_PENDING = "Answer the pending question or approval first.";
const THREAD_STILL_WORKING = "This thread is still working. Try again when the turn ends.";
/** The server refuses `/no` from No project with the same sentence. */
export const THREAD_ALREADY_IN_NO_PROJECT = "This thread is already in No project.";

/** A slash menu row ends with no period, like the rows around it. */
export function slashMenuRowText(sentence: string): string {
  return sentence.replace(/\.$/u, "");
}

export function folderMoveBlockReason(input: {
  readonly supported: boolean;
  readonly isLocalDraftThread: boolean;
  readonly editingQueuedMessage: boolean;
  readonly requestPending: boolean;
  readonly textOnly: boolean;
}): string | null {
  if (!input.supported) return "Update this environment's T3 Code server to move threads.";
  if (input.isLocalDraftThread) return DRAFT_CHOOSES_PROJECT;
  if (input.editingQueuedMessage) return QUEUED_EDIT_OPEN;
  if (input.requestPending) return REQUEST_PENDING;
  if (!input.textOnly) return "Remove the attachments and context, then send it again.";
  return null;
}

/** A path in backticks; a path with a backtick in it sits in double backticks with a space. */
const INLINE_CODE = /``\s?(.+?)\s?``|`([^`]+)`/gu;

/**
 * Splits a refusal or a receipt at its backtick spans, which hold paths. The text around a path
 * stays as written, its spaces and punctuation included.
 */
export function splitInlineCode(text: string): ReadonlyArray<InlineCodePart> {
  const parts: Array<InlineCodePart> = [];
  let end = 0;
  for (const match of text.matchAll(INLINE_CODE)) {
    if (match.index > end) {
      parts.push({ code: false, text: text.slice(end, match.index), offset: end });
    }
    parts.push({ code: true, text: match[1] ?? match[2] ?? "", offset: match.index });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ code: false, text: text.slice(end), offset: end });
  return parts;
}

/** `offset` is where the part starts in the text, so it identifies the part when rendering. */
export interface InlineCodePart {
  readonly code: boolean;
  readonly text: string;
  readonly offset: number;
}

/** Why the slash menu shows `/cd` and `/no` as blocked, before the user types the command. */
export function folderMoveMenuBlockReason(input: {
  readonly isLocalDraftThread: boolean;
  readonly editingQueuedMessage: boolean;
  readonly requestPending: boolean;
  readonly running: boolean;
}): string | null {
  if (input.isLocalDraftThread) return DRAFT_CHOOSES_PROJECT;
  if (input.editingQueuedMessage) return QUEUED_EDIT_OPEN;
  if (input.requestPending) return REQUEST_PENDING;
  if (input.running) return THREAD_STILL_WORKING;
  return null;
}

export type ThreadMoveQuestion = Extract<ThreadMoveResult, { _tag: "needs-project" | "confirm" }>;
type ThreadMoveOutcome = Extract<ThreadMoveResult, { _tag: "moved" | "refused" }>;

export async function runThreadMove(
  input: ThreadMoveInput,
  move: (input: ThreadMoveInput) => Promise<ThreadMoveResult>,
  ask: (question: ThreadMoveQuestion) => Promise<boolean>,
): Promise<ThreadMoveOutcome | null> {
  const result = await move(input);
  if (result._tag === "moved" || result._tag === "refused") return result;
  if (!(await ask(result))) return null;
  const flags = result._tag === "needs-project" ? { addProject: true } : { confirm: true };
  return runThreadMove({ ...input, ...flags }, move, ask);
}

export interface ThreadMoveDialogCopy {
  readonly title: string;
  /** Null when the client does not know the thread's folder. */
  readonly from: string | null;
  /** Null for a new scratch folder. */
  readonly to: string | null;
  readonly lines: ReadonlyArray<string>;
  readonly confirmLabel: string;
}

/** The dialog shows each path once, in its From and To rows, so no line repeats one. */
export function threadMoveDialogCopy(
  question: ThreadMoveQuestion,
  currentFolder: string | null,
): ThreadMoveDialogCopy {
  if (question._tag === "needs-project") {
    return {
      title: "Create a project and move this thread?",
      from: currentFolder,
      to: question.folder,
      lines: [
        question.nestedIn
          ? `The new project is nested in project ${question.nestedIn.title}.`
          : "This folder has no project yet.",
      ],
      confirmLabel: "Create project and move",
    };
  }
  const wayBack = {
    cd: "/cd to the From folder brings the thread back as a root thread.",
    "add-project": "Add the From folder as a project first, and /cd to it brings the thread back.",
    none: 'No command brings the thread back here. To keep a way back, cancel and choose "Turn into project" first.',
  }[question.wayBack];
  return {
    title: question.wayBack === "none" ? "Leave this scratch folder?" : "Leave this worktree?",
    from: question.from,
    to: question.to,
    lines: [
      question.staysOnDisk.replace(`The folder ${question.from} `, "The folder "),
      wayBack,
      ...(question.project
        ? [`The folder stays the root of project ${question.project.title}.`]
        : []),
      ...(question.otherThreads.length > 0
        ? [
            `Still working there: ${question.otherThreads.map((thread) => thread.title).join(", ")}.`,
          ]
        : []),
    ],
    confirmLabel: "Move thread",
  };
}
