# Review changes

On desktop, open **Review changes** from a thread’s Git menu and choose **Uncommitted** to review the working copy. Use **Files** for the combined changed-file tree or **Git** for separate staged and unstaged trees.

On mobile, open **Git** from the thread toolbar and choose uncommitted changes, branch changes, or a turn comparison. Git opens directly on its file tree. Select a file to inspect its diff; Back returns to the tree. The **Files** tab browses the full workspace and file contents.

For uncommitted changes, stage files or individual hunks; unstage them to return them to the remaining work. Partially staged files appear in both Git trees, and the Git tab counts each changed file once. File, folder, and section actions stage, unstage, or revert their changes; reverting asks for confirmation and keeps staged changes. Use **Commit** or choose **Commit (Amend)** or **Commit & Push** from its dropdown to run that action on staged changes. Leave the message blank to generate one from staged content, or use the sparkle button to generate an editable preview. Staging leaves file contents intact.

## Review a pull request

Open a pull request from **Pull Requests**. **Overview** brings its description, checks, and activity together. With review guides enabled in Source Control settings, opening **Guide** generates a chapter walkthrough when one is missing. Each chapter contains its own files; marking a chapter reviewed also marks those files viewed on GitHub.

Mark individual files reviewed inside Guide to work through a chapter one file at a time. Reviewing every file completes the chapter. GitHub viewed marks stay synchronized across Guide and Code, including changes made on GitHub while the review is open.

In **Code** on desktop or **Diff** on mobile, select a contiguous commit range, all commits, or changes since your last review. **Group by file type** reviews Implementation, Tests, and Generated files as separate chapters. Reviewing or clearing a chapter changes the viewed status of all its files, including files hidden by filters. Load the complete diff before marking a chapter reviewed. A folder’s context menu can mark its files reviewed or unreviewed. **Hide reviewed** hides viewed files while retaining their progress.

## Leave feedback

Select a line or range to add a review comment. On mobile, tap the first line, then the last; long-press a line to start a new selection. On desktop, `Cmd/Ctrl+Enter` adds an inline draft to your review and `Cmd/Ctrl+Shift+Enter` sends its context to the agent composer. Adding to a review keeps the comment private until you submit the review. On GitHub, **Copy link** on a pending comment saves it in your private draft review and copies its actual comment URL. Saved pending comments survive reload, and discarding one removes it from the GitHub draft.

Use the paperclip or drop supported images and videos onto a desktop composer to insert an attachment at the cursor. Hosted HTTP or HTTPS links can be pasted directly into the comment. Local uploads require GitHub.com or GitHub Enterprise Cloud and repository write access; other hosts and read-only repositories support hosted links. Uploads finish before you can submit the comment.

When merge requirements are unmet, GitHub administrators who can merge can enable **Merge without waiting for requirements to be met (bypass rules)** in the merge confirmation. Bypassing merges immediately; auto-merge waits for checks.
