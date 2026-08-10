# Worktrees

T3 Code can create a Git worktree when you start a thread. Select **New worktree** and choose the base branch.

The worktree gives the thread an isolated checkout. Your original checkout stays on its current branch.

## Set the branch prefix

1. Open **Settings**.
2. Select **General**.
3. Enter a value in **Worktree branch prefix**.

The default prefix is `t3code`. A temporary branch can have the name `t3code/a1b2c3d4`.

Use one segment that starts with a letter, digit, or underscore. The rest can use letters, digits, hyphens, or underscores. The maximum length is 64 characters.

T3 Code removes spaces at the start and end. It saves uppercase letters as lowercase letters.

The field shows the final `/`. Do not enter the slash in the prefix.

Each server stores its own prefix. A remote or mobile task uses the setting from the selected environment.

T3 Code can replace the temporary name after the first turn. The new branch keeps the configured prefix.

The worktree directory follows the temporary branch name. T3 Code replaces `/` with `-` in the default directory segment.

For example, `team/a1b2c3d4` uses `team-a1b2c3d4` in the default worktree path.

Changing the setting does not rename existing branches or worktrees. It applies only to new thread worktrees.

T3 Code recognizes the current prefix and legacy `t3code` branches as temporary. It does not keep a history of custom prefixes. If a temporary branch uses an older custom prefix, T3 Code no longer applies automatic branch naming to it.
