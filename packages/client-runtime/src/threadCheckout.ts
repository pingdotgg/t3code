// A thread checkout Git no longer recognises inside a project it still does was removed, so git
// controls work from the project checkout and picking a ref there rebinds the thread.
export function isThreadCheckoutMissing(input: {
  worktreePath: string | null;
  worktreeIsRepo: boolean | undefined;
  projectIsRepo: boolean | undefined;
}): boolean {
  return (
    input.worktreePath !== null && input.worktreeIsRepo === false && input.projectIsRepo === true
  );
}
