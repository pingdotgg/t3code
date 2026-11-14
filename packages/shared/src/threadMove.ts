/** What moving a thread to another project changes, worded the same for people and agents. */
export function threadMoveNotice(input: {
  readonly projectTitle: string;
  readonly fromWorktree: boolean;
}): string {
  return input.fromWorktree
    ? `The agent will work in ${input.projectTitle}'s root folder. The worktree and its branch stay on disk, but the agent won't see changes left there. Earlier diffs open while the worktree exists, and files from earlier turns can't be restored.`
    : `The conversation moves with it, and the agent works in ${input.projectTitle}'s folder from the next message. Earlier diffs open while their original folder exists, and files from earlier turns can't be restored.`;
}
