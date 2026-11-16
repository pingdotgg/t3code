# Projects with several repositories

A project can cover more than one repository, so one thread can read and change all of them. This
fits three common setups:

- A plain folder that holds several repositories, such as `shop/api` and `shop/web`.
- A repository that works alongside others it depends on, anywhere on the machine.
- A repository with submodules.

The project folder does not have to be a Git repository itself.

## Track repositories

When you add a folder as a project, T3 Code looks for repositories one level down, and one level
further inside folders that are not repositories themselves, such as `src` or `packages`. It also
reads a `.code-workspace` file if there is one. It then asks which of them to track. Worktrees of
another repository are not offered.

To change the list later, open **Settings → Projects**, choose the project, and look under
**Repositories**:

- **Rescan** looks again and offers what is new.
- **Add folder**, on web and desktop, takes any folder on that machine, including one outside the
  project folder.
- **Remove** stops tracking a folder. It never deletes files.

A project can track up to 128 folders. The list belongs to one machine: the same project on
another machine has its own.

From a script, `t3 project add <path> --track-repos` tracks every repository it finds, and
`--track <folder>` adds one by path.

### Follow a folder

A tracked list is a snapshot. To have it follow the disk instead, turn on **Keep following this
folder** when you add the project or rescan. It needs every found repository selected. Repositories
cloned into that folder later are tracked without a rescan, and removed ones drop out.

Following is stored as a rule: a path with a `*` segment, such as `/work/shop/src/*`, which tracks
every repository at a matching place. You can also type a rule into **Add folder**, or pass one to
the command line with `--track 'src/*'`. Worktrees of another repository and submodules never match
a rule. Repositories that a `.code-workspace` file lists stay tracked by name.

### Submodules

Submodules need no setup. A thread that changes one shows it as its own repository, with its own
diff and Git actions, while the repository that holds it shows the changed pin. A submodule is never
offered for tracking and never gets a worktree of its own, because its parent repository decides
where it is checked out.

## Review changes

Each turn lists the files it changed, grouped by repository, and its diff covers all of them. See
[Review turn changes](source-control.md#review-turn-changes).

On web and desktop, the Diff pane's **Uncommitted**, **Changes**, and **Commits** sources read one
repository at a time. Pick it from the repository picker next to the source picker. The picker
lists every repository the thread reaches, including ones no turn has touched, so edits you made by
hand show up too.

## Commit, push, and open pull requests

Git actions run in one repository at a time.

- **Web and desktop:** the thread details panel lists the repositories the thread changed, most
  recent first, each with its branch and uncommitted changes. Expand one to commit, push, or open a
  pull request there. **Other repositories...** adds any other tracked repository.
- **Mobile:** open **Git controls** in the thread. The sheet lists the repositories under
  **Repositories**; tap one for its own commit, push, and pull request actions.

A pull request opened in a repository is linked to the thread under that repository, not under the
project's.

## Worktree threads

**New worktree** works for these projects too. The thread gets its own folder laid out like the
project, and each repository you choose gets a worktree there, all on the thread's branch.

Choose the repositories with the repositories control next to the workspace picker before you send.
Every tracked repository is included when the project tracks eight or fewer; with more, none is
included until you choose. On web and desktop, your last choice is remembered for the project in
that browser. To bring another repository into a running thread, pick it under **Other
repositories** in the thread details panel or the mobile Git sheet.

Each repository starts from the thread's base branch where it has a branch of that name, and from
its own default branch otherwise. A plain folder has no branch picker, so on web and desktop you
name the base branch at the bottom of the repositories control.

In a plain folder, the files outside your repositories are shared links to the originals, not
copies. Editing one changes it for every thread.

### Lay the folder out yourself

If the default layout does not suit your project, for example because build output must be per
thread, workspace metadata has to be generated, or submodules need preparing, the project can
create the folder with its own command. Add this to the `t3.json` in the project folder:

```json
{
  "worktreeLayout": {
    "create": "./scripts/new-workspace.sh",
    "remove": "./scripts/remove-workspace.sh"
  }
}
```

`create` runs in the project folder and must leave the thread's copy of the project folder in
place. It receives these environment variables:

| Variable                   | Value                                               |
| -------------------------- | --------------------------------------------------- |
| `T3_PROJECT_ROOT`          | The project folder.                                 |
| `T3_WORKTREE_ROOT`         | The empty folder to fill for this thread.           |
| `T3_WORKTREE_PROJECT_PATH` | Where the project folder goes inside it.            |
| `T3_WORKTREE_BRANCH`       | The thread's branch name.                           |
| `T3_WORKTREE_BASE`         | The base branch, or empty when the thread has none. |

Every tracked repository the command checks out at the same relative place becomes the thread's
checkout of it. The repositories control is ignored for such a project. `remove` is optional and
runs before T3 Code removes whatever is left.

A project that tracks no other repository can declare a layout too. This example gives each thread
a worktree with its submodules checked out:

```json
{
  "worktreeLayout": {
    "create": "git worktree add -b \"$T3_WORKTREE_BRANCH\" \"$T3_WORKTREE_PROJECT_PATH\" ${T3_WORKTREE_BASE:-HEAD} && git -C \"$T3_WORKTREE_PROJECT_PATH\" submodule update --init"
  }
}
```

## Limits

- One Git action runs in one repository. There is no commit or push across several at once.
- Only the project folder's `t3.json` is read. Setup scripts and actions inside a tracked
  repository are not picked up.
- The Diff pane's repository picker and the base branch field for a plain folder are on web and
  desktop only.
