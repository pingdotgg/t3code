export function getArchivedProjectRemovalWarning(input: {
  memberCount: number;
  hasLiveThreads: boolean;
}): string {
  const projectLabel = input.memberCount === 1 ? "this project" : "these projects";
  if (input.hasLiveThreads) {
    return `This permanently clears conversation history for those threads and any archived conversations in ${projectLabel}.`;
  }
  const verb = input.memberCount === 1 ? "has" : "have";
  return `If ${projectLabel} ${verb} archived conversations, their history will also be permanently deleted.`;
}

export function resolveArchivedProjectRemovalCommandOptions(
  hasLiveThreads: boolean,
): { readonly force: true } | { readonly deleteArchivedThreads: true } {
  if (hasLiveThreads) {
    return { force: true };
  }

  // Archived shells are intentionally absent from the client's live thread
  // list. Preserve the server's live-thread precondition while opting this
  // project member's cold bundles into removal.
  return { deleteArchivedThreads: true };
}

export function buildArchivedProjectRemovalPlans<
  TMember extends { readonly environmentId: string; readonly id: string },
  TThread extends { readonly environmentId: string; readonly projectId: string },
>(
  members: readonly TMember[],
  projectThreads: readonly TThread[],
): {
  readonly member: TMember;
  readonly memberThreads: TThread[];
  readonly commandOptions: { readonly force: true } | { readonly deleteArchivedThreads: true };
}[] {
  return members.map((member) => {
    const memberThreads = projectThreads.filter(
      (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
    );
    return {
      member,
      memberThreads,
      commandOptions: resolveArchivedProjectRemovalCommandOptions(memberThreads.length > 0),
    };
  });
}

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}
