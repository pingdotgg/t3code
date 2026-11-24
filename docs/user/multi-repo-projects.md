# Projects with several repositories

A project can cover more than one repository, so one thread can read and change all of them. This
fits three common setups:

- A plain folder that holds several repositories, such as `shop/api` and `shop/web`.
- A repository that works alongside others it depends on, anywhere on the machine.
- A repository with submodules.

The project folder does not have to be a Git repository itself.

## Which repositories a project covers

There is no list to keep. A project covers every repository inside its folder: T3 Code looks one
level down, and one level further inside folders that are not repositories themselves, such as
`src` or `packages`. It reads the disk each time, so a repository you clone there is part of the
project straight away, and one you delete is gone from it. Worktrees of another repository are left
out.

**Settings → Projects → Repositories** shows what the project covers on each machine.

### Folders outside the project

A repository somewhere else on the machine has to be added, because adding it lets agents work in a
place they could not reach before.

- On web and desktop, use **Add folder** under **Repositories**.
- If the project folder has a `.code-workspace` file, the folders it lists outside the project are
  offered there with an **Add** button, on mobile too.
- From a script, `t3 project add <path> --track <folder>` adds one.

**Remove** takes an added folder out of the project. It never deletes files. Added folders are
paths on one machine, so the same project on another machine has its own. A project can cover up to
128 folders.

### Leave a repository out

To keep a repository inside the project folder out of the project, name it in the `t3.json` in the
project folder, relative to that folder:

```json
{
  "ignoreRepositories": ["vendor/big"]
}
```

It is then not reviewed on its own and gets no worktree. Because the file is checked in, the choice
applies on every machine.

### Submodules

Submodules are checked out when a worktree is created. If that fails, a submodule stays
uninitialized and the thread does not list it until you run `git submodule update --init` in the
thread's folder. A thread that changes one shows it as its own repository, with its own diff and
Git actions, while the repository that holds it shows the changed pin. A submodule never
gets a worktree of its own, because its parent repository decides where it is checked out.

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
  pull request there. **Other repositories...** adds any other repository of the project.
- **Mobile:** open **Git controls** in the thread. The sheet lists the repositories under
  **Repositories**; tap one for its own commit, push, and pull request actions.

A pull request opened in a repository is linked to the thread under that repository, not under the
project's.

## Worktree threads

**New worktree** works for these projects too. The thread gets its own folder laid out like the
project, and each repository you choose gets a worktree there, all on the thread's branch.

Choose the repositories with the repositories control next to the workspace picker before you send.
Every repository is included when the project covers eight or fewer; with more, none is
included until you choose. A repository with no commit yet is left out, since it has nothing to
branch from. On web and desktop, your last choice is remembered for the project in
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

| Variable                   | Value                                                      |
| -------------------------- | ---------------------------------------------------------- |
| `T3_PROJECT_ROOT`          | The project folder.                                        |
| `T3_WORKTREE_ROOT`         | The empty folder to fill for this thread.                  |
| `T3_WORKTREE_PROJECT_PATH` | Where the project folder goes inside it.                   |
| `T3_WORKTREE_BRANCH`       | The thread's branch name.                                  |
| `T3_WORKTREE_BASE`         | The base branch, or empty when the thread has none.        |
| `T3_WORKTREE_REPOSITORIES` | The repositories chosen for the thread, one path per line. |

Every repository of the project that the command checks out at the same relative place becomes the
thread's checkout of it. `remove` is optional and runs before T3 Code removes whatever is left.

What the commands can rely on, and what they must do:

- **Checkouts are linked worktrees on the thread's branch.** Make each one with
  `git worktree add` from the repository it belongs to, on `T3_WORKTREE_BRANCH`. T3 Code later
  removes, restores, and renames these through Git, so it refuses a clone or a checkout on another
  branch and the thread does not start.
- **`create` can run more than once.** It runs again when a thread's folder has gone missing, by
  which time the branch already exists. Check the branch out when it is there and create it
  otherwise.
- **`remove` can run on a folder that is partly gone**, such as after a failed `create` or an
  earlier cleanup. Storage cleanup never deletes files that exist only in the thread's folder, so
  `remove` should delete what `create` generated.
- **A failed `create` is rolled back.** Checkouts it already made are removed.
- **One command runs at a time per project**, so a command can update a shared file in the project
  folder without its own locking.
- **Each command has ten minutes.**
- **The commands run only for requests that may run commands on the host.** A client paired
  without `orchestration:operate` and `terminal:operate`, and a thread started through a
  [linked environment](remote-access.md#link-another-environment) paired below full access, get no worktree in a project
  that declares a layout, and their cleanup leaves `remove` out.

#### Approve the commands

T3 Code runs `create` and `remove` only after you have approved them. The first time you start a
worktree thread in the project from the web or desktop app, it shows both commands in full and asks.
**Approve and continue** records the approval and starts the thread; **Cancel** leaves your draft as
it was. You can also review, approve, and revoke each command under **Worktree layout** in the
project's settings. Approving needs a client that can use the terminal (`terminal:operate`).

An approval is kept on the environment, not in the repository, and covers the exact text of one
command for one project. When the text in `t3.json` changes, for example after a pull, the command
stops running until you approve the new text. An approval covers the command text only: when the
command runs a script file, later changes to that file do not ask again.

While a command is not approved:

- **Nothing that needs `create` gets a worktree.** A worktree thread started from the mobile app,
  by a scheduled task, or by an agent fails with a message that says so. Approve the command in the
  web or desktop app, then start it again.
- **A thread folder that went missing comes back as plain checkouts**, without the project's
  `create`.
- **Removing a thread's worktree skips `remove`** and removes the checkouts.

Agents never approve a command, and an approval is not enough for one that works below Full access.
When an agent hands its thread off to a worktree or starts a worktree thread, the commands run
only if the thread that asked is in Full access when they are about to run. Below that, or where an
administrator's [policy](managed-policy.md) does not allow Full access, a project that declares a
layout gets no worktree from the agent. In any project, an action set to **Run automatically on worktree
creation** does not run for a worktree an agent asked for below Full access. Start the worktree
thread yourself, or switch the thread to Full access.

An administrator can turn these commands off for a machine with
[`worktreeLayoutCommands`](managed-policy.md#other-capabilities).

A project with no other repository can declare a layout too. This example gives each thread
a worktree with its submodules checked out. The command runs in `sh`, and in `cmd.exe` on Windows,
so write it for the shell of the machine the project is on; this one is for `sh`:

```json
{
  "worktreeLayout": {
    "create": "(git worktree add \"$T3_WORKTREE_PROJECT_PATH\" \"$T3_WORKTREE_BRANCH\" 2>/dev/null || git worktree add -b \"$T3_WORKTREE_BRANCH\" \"$T3_WORKTREE_PROJECT_PATH\" ${T3_WORKTREE_BASE:-HEAD}) && git -C \"$T3_WORKTREE_PROJECT_PATH\" submodule update --init"
  }
}
```

## Rewind

Rewinding a thread restores its project folder and each repository it works in. Two cases are not
restored:

- **A plain project folder.** Only repositories have snapshots, so files that sit outside every
  repository keep their current contents.
- **A repository with no earlier snapshot.** If nothing was recorded for a repository before the
  turns you discard, it keeps their changes. The rewind still completes and names the repositories
  it left, so check their uncommitted changes afterwards.

## Limits

- One Git action runs in one repository. There is no commit or push across several at once.
- Only the project folder's `t3.json` is read. Setup scripts and actions inside one of its
  repositories are not picked up.
- The Diff pane's repository picker and the base branch field for a plain folder are on web and
  desktop only.
