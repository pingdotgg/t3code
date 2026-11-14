/** What moving a thread to another project changes, worded the same for people and agents. */
export function threadMoveNotice(input: {
  readonly projectTitle: string;
  readonly fromWorktree: boolean;
}): string {
  return input.fromWorktree
    ? `The agent will work in ${input.projectTitle}'s root folder. The worktree and its branch stay on disk, but the agent won't see changes left there. Earlier diffs open while the worktree exists, and files from earlier turns can't be restored.`
    : `The conversation moves with it, and the agent works in ${input.projectTitle}'s folder from the next message. Earlier diffs open while their original folder exists, and files from earlier turns can't be restored.`;
}

/** What moving a thread to another machine carries and leaves behind; names only what applies. */
export function threadMachineMoveNotice(input: {
  readonly fromMachine: string;
  readonly toMachine: string;
  readonly projectTitle: string;
  readonly leftBehind: {
    readonly diffs: boolean;
    readonly worktree: boolean;
    readonly attachments: number;
    readonly scheduledTasks: number;
  };
}): string {
  const { leftBehind } = input;
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const stays = [
    "Files",
    ...(leftBehind.diffs ? ["diffs"] : []),
    ...(leftBehind.worktree ? ["the worktree"] : []),
    ...(leftBehind.attachments > 0 ? [count(leftBehind.attachments, "attachment")] : []),
    ...(leftBehind.scheduledTasks > 0 ? [count(leftBehind.scheduledTasks, "scheduled task")] : []),
  ];
  const list =
    stays.length === 1 ? stays[0] : `${stays.slice(0, -1).join(", ")} and ${stays.at(-1)}`;
  return `The conversation moves to ${input.projectTitle} on ${input.toMachine} and continues in a new session there. ${list} stay on ${input.fromMachine}, where this thread is archived. Unarchive it to come back.`;
}
