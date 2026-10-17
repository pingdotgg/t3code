# File links in messages

On web and desktop, right-click a file link in a message to copy its path.
**Copy full path** copies the resolved path on the connected environment when
resolution succeeds. Otherwise, it copies the original target.
**Copy relative path** appears when a workspace-relative path is available and
copies that path without the workspace folder's name. Links with a line or
column keep that position in either copied value.

Relative links use the thread's worktree folder, or the project folder when the
thread has no worktree. They do not follow directory changes made by an agent's
commands. Absolute links to files elsewhere, such as a temporary report outside
the project, offer **Copy full path**.
