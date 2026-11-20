/** The confirm before T3's manual worktree delete, which keeps the branch and loses uncommitted changes. */
export function DeleteWorktreeConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Delete the worktree?"
      className="flex flex-col gap-2 rounded-md border border-red-400/40 p-2.5"
    >
      <p>Delete the worktree? Its branch stays, and uncommitted changes in it are lost.</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md bg-red-500 px-2.5 py-1 font-medium text-white hover:bg-red-400"
        >
          Delete worktree
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line px-2.5 py-1 text-fg hover:bg-hover"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
