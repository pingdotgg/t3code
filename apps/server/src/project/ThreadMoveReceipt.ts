import type { OrchestrationV2TurnItem, ThreadId, TurnItemId } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

const quote = (title: string) => `"${title}"`;

/** Inline code, so the client renders the path as a file link. */
const receiptPath = (path: string) => (path.includes("`") ? `\`\` ${path} \`\`` : `\`${path}\``);

export interface ThreadMoveReceiptInput {
  readonly folder: string;
  readonly previousFolder: string;
  readonly project: string;
  readonly previousProject: string;
  readonly members: ReadonlyArray<string>;
  readonly clearedBranch: string | null;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  /** The worktree or scratch folder the thread leaves; null for a move out of a project root. */
  readonly leftFolder: {
    readonly exists: boolean;
    /** The project rooted in the folder, named instead of its root threads. */
    readonly project: string | null;
    readonly otherThreads: ReadonlyArray<string>;
  } | null;
}

/** The first line is the heading the client shows; the lines after it are the details. */
export function threadMoveReceiptMessage(input: ThreadMoveReceiptInput): string {
  const left = input.leftFolder;
  const working =
    left === null
      ? []
      : [
          ...(left.project === null ? [] : [`project ${quote(left.project)}`]),
          ...left.otherThreads.map(quote),
        ];
  const pullRequest = input.pullRequest;
  const previousFolder = receiptPath(input.previousFolder);
  return [
    `Moved to ${input.project}.`,
    // A thread out of a project root names the root; a worktree or scratch folder is its own place.
    left === null
      ? `It came from project ${quote(input.previousProject)}, which has its root at ${previousFolder}.`
      : `It came from project ${quote(input.previousProject)}, where it worked in ${previousFolder}.`,
    `The next turn runs in ${receiptPath(input.folder)}.`,
    left !== null &&
      (left.exists
        ? `The folder ${previousFolder} stays on disk with all its files until you remove it.`
        : "The folder no longer exists."),
    left !== null &&
      (working.length === 0
        ? "No other thread works in it."
        : `Still working in it: ${working.join(", ")}.`),
    input.members.length > 0 && `Moved with it: ${input.members.map(quote).join(", ")}.`,
    input.clearedBranch !== null &&
      `Cleared the branch ${quote(input.clearedBranch)}.${pullRequest === null ? "" : ` Its pull request #${pullRequest.number} (${pullRequest.url}) stays linked.`}`,
    "Open terminals keep their folder.",
  ]
    .filter((line) => typeof line === "string")
    .join("\n");
}

export function threadMoveMemberNotice(threadTitle: string, folder: string): string {
  return [
    `Moved with ${threadTitle}.`,
    `The next turn runs in ${receiptPath(folder)}.`,
    `The receipt in ${threadTitle} lists the details.`,
  ].join("\n");
}

export function moveReceiptTurnItem(input: {
  readonly id: TurnItemId;
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly movedAt: DateTime.Utc;
  readonly previousFolder: string;
  readonly message: string;
}): OrchestrationV2TurnItem {
  return {
    id: input.id,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed",
    title: null,
    startedAt: input.movedAt,
    completedAt: input.movedAt,
    updatedAt: input.movedAt,
    type: "system_notice",
    message: input.message,
    previousFolder: input.previousFolder,
  };
}

/** `items` sorted by ordinal, as the history read returns them. */
export function previousFolderAfter(
  items: ReadonlyArray<
    Pick<OrchestrationV2TurnItem, "type" | "ordinal"> & {
      readonly previousFolder?: string | undefined;
    }
  >,
  ordinal: number,
): string | undefined {
  return items.find(
    (item) =>
      item.ordinal > ordinal && item.type === "system_notice" && item.previousFolder !== undefined,
  )?.previousFolder;
}
