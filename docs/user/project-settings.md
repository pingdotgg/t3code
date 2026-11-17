# Settings and project overrides

On web and desktop, the "Applying settings for …" sentence at the top of Settings pages picks
the project and environment a change applies to. Pages that only hold device preferences, such as
Appearance, don't show it. They start at **All projects** and **All environments**
and stay selected as you move between categories or search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, ignore
the environment selection. On the Browser page they are read-only while a project is selected,
though profiles can still be added, renamed and removed. Everything else is stored on a server.
Choose one environment to edit its settings, or leave **All environments** to edit every connected
environment at once. Offline environments keep their current values; this is a bulk edit, not a
synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

With a project selected, a provider's switch in **Settings → Providers** turns it on or off for
that project only, in either direction: a provider off on the machine can be used in one project,
and one on everywhere can be kept out of another. That project's model pickers follow the switch,
and no new turn there can start on a provider it turned off, including queued messages and
follow-ups from delegated tasks. A turn already running when the switch flips finishes. A delegated
task's result still lands in its parent thread, which sees it on its next turn. Reset returns the project to the
machine's setting. Every other provider setting stays per machine.

On mobile, open **Settings** and use the filter in its header to choose connected environments
and a project. The filter stays available in server-setting pages. With **All projects** selected,
the server-setting pages, such as Threads, Source control and Worktrees, edit the selected
environments' defaults. Choosing a project edits its overrides on the selected
environments. Use **Use defaults** in a page to remove that page's project overrides.
Open **Settings → Projects** to rename the project across its selected
connected checkouts and see where those checkouts live.
Settings that are environment-wide stay read-only while a project is selected. When selected
targets disagree, a control shows **Mixed** until you choose one value. Appearance, keyboard,
and other phone-only settings ignore the filter.

## Pin and archive projects

Pinned projects come first in the project pickers: the project picker on a new thread, the
new-thread list, the command palette, the sidebar project filter, and mobile. In the boring sidebar, pinned projects get the top
folders, even with no active threads. Pin or unpin a project from its row in any of those lists,
or press the thread pin shortcut (`mod+shift+p` by default) on the highlighted row. **Pin
project** in the command palette and **Settings → Projects** work too. A list keeps its order
while it is open, so a new pin moves up the next time you open it.

Archive a project you are done with in **Settings → Projects**. It leaves the project pickers.
Its threads, settings, and files stay as they are, and archived projects still show in the
Settings project list, marked **Archived**. Choose one there and select **Unarchive** to bring it
back. On mobile, both are in **Settings → Projects → Organize**.

A project on several machines must have every machine connected to pin or archive it.

## Worktree branch names

In **Settings → Worktrees → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `t3/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named new worktree branches. Select a project
to override its environment defaults. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Scheduled tasks on mobile

Open **Settings → Scheduled tasks** to create scheduled tasks or manage existing
ones across your connected environments. Use the settings filter to narrow the
list by environment or project. Each task runs on the environment you choose,
using its project, model, and workspace settings. Fixed-time schedules use that
environment's time zone, which may differ from your phone's. Choose **Once**
to run a task a single time at a date and time in your own time zone. If the
environment is offline then, the task runs when it is back.

Under **Destination**, choose where runs go. **New thread each run** keeps every
run separate. The two one-thread choices start a thread on the first run and post
later runs there: one continues the same conversation, the other starts each run
in a fresh session that doesn't see earlier runs, so the thread stays readable
without the agent's context growing. To move a one-thread task, pick another
thread in its project under **Destination**. Moving such a task to another
project starts a new thread there on its next run.

Deleting a thread also deletes tasks that post into that thread. Tasks that start
a new thread on each run survive deletion of their previous threads.

You can edit, pause, resume, run immediately, or delete a task from the list.
Webhook tasks only run when their URL is called, so they can't be run
immediately.
Leaving an edited form asks before discarding unsaved changes.

### Stale tasks are archived

Tasks that stop doing anything are archived after 10 days: a one-time task after
its run, a task paused or left off for 10 days, a task whose runs have failed at
least three times in a row for 10 days, and a task whose thread has been
archived for 10 days. A webhook task is archived only if its URL received no
request for 30 days since you created or last edited it; a webhook that has run
is never archived for being quiet. Archiving turns the task off.

Choose **Archived** at the top of the list to see these tasks, why each was
archived, and the date it will be deleted, 30 days after archiving. **Restore**
turns a task back on; a one-time task whose time passed opens the editor so you
can pick a new time. Saving an archived task also restores it. A restored
webhook keeps its URL. The 10-day and 30-day windows can't be changed.

## Webhook automations

In **Settings → Scheduled tasks**, choose **On webhook**
as a task's schedule to run it whenever another service calls its URL, such as
a CI job that failed. The URL uses the machine's
[Tailscale HTTPS](remote-access.md#tailscale-https) address, so only senders on
your tailnet can reach it; outside services such as GitHub or Linear cannot.
After you save the task, copy its URL from the editor. Without a Tailscale HTTPS
address, the editor shows only the URL's path.
**Rotate** replaces the URL and the old one stops working.

The prompt decides what the agent sees. Placeholders pull values out of the
request: `{{body.path}}` for a JSON or form field, `{{headers.name}}`,
`{{query.name}}`, `{{body}}` for the raw body, and `{{request}}` for everything.
For example, `Review this PR: {{body.pull_request.html_url}}` sends only the
pull request link. A placeholder with no value is left empty.

Each value reaches the agent wrapped in `<webhook-data-…>` tags and marked as
untrusted request data. This helps the agent tell it apart from your
instructions, but it doesn't guarantee the agent ignores what the text says.
Inside a value, every `$`, other currency sign and `@`, and a `/` that starts
a lone word, gets an invisible character after it, so mentions like `$skill`,
`@file` and `/command` don't act. Text copied from a value, such as an email
address or a command, carries that character too. Without a signature, anyone
with the URL can start a run with any content. A signature only proves which
service sent the request: a GitHub payload still carries text written by any
GitHub user.

For GitHub, turn on **Require signature**, keep the header
`x-hub-signature-256`, hex encoding and the `sha256=` prefix, and enter the
same secret in the repository's webhook settings with content type
`application/json`. Requests without a valid signature are rejected. Set this
up on desktop or web; mobile keeps an existing signature check but can't turn
one on.

To run only for some requests, add **Filters**. Each one tests a value named
like a placeholder, without the braces, such as `headers.x-github-event` equals
`pull_request` or `body.action` is one of `opened, reopened`. A task runs only
when every filter matches; other requests are answered normally, logged as
**Filtered** with the first filter that failed, and start nothing. Values
compare as text, and a value that is an object or a list only passes
**exists**. Separate **is one of** values with commas; a value can't contain
a comma or start or end with a space.

To suppress repeated deliveries, set a **Duplicate request key** template, such as
`{{headers.delivery-id}}`. The same key is ignored for seven days per task.
To combine a burst, set a **Coalesce key**, such as `{{body.id}}`, and a window
of 10–3600 seconds (120 by default). One run uses the latest body, headers,
and query when the window from the first delivery closes; later requests
do not extend it. Pending windows survive a server restart. Keys must contain
request placeholders; if any placeholder is missing, or the render is empty,
that key's rule is skipped. Clear the templates to turn dedupe off.

Duplicate and coalesced log entries share a limit of 10 per task per minute.
Additional deliveries are accepted without a log entry, and coalesced deliveries
always replace the persisted payload. Coalesced updates count toward a separate
60-per-minute validation limit; exceeding it receives HTTP 429.

A script that may retry a request can send an `Idempotency-Key` header, 1 to
200 printable characters with no spaces. Ada runs the task once per key
for 48 hours; a retry with the same key is accepted as a duplicate and answers
with the first delivery's id. A malformed key gets a 400 and nothing runs.

On desktop and web, pick **Deliveries** from a task's menu to see recent
requests and the prompt each one produced.

If the environment is offline, the sender gets an error and nothing runs;
redeliver from the sender once it is back.

### Trigger a webhook only when something changes

`ada watch` turns external state into a webhook call without spending a model
run on polling. It probes a file, an HTTP endpoint, or a command's exit status,
and sends one POST to your webhook task only when a value changes into one you
listed. While nothing changes it sends nothing. Send actionable changes only,
never routine progress.

```json
{
  "name": "build-box",
  "webhookUrl": "https://<the webhook URL shown for the task>",
  "intervalSeconds": 30,
  "probes": [
    { "kind": "file", "name": "lease", "path": "/var/run/build.lease", "notify": ["present"] },
    {
      "kind": "http",
      "name": "api",
      "url": "http://localhost:8080/health",
      "notify": ["status:500", "unreachable"]
    },
    {
      "kind": "command",
      "name": "backup",
      "argv": ["/usr/local/bin/check-backup"],
      "notify": ["exit:1"]
    }
  ],
  "deadlines": [
    {
      "name": "backup-by-dawn",
      "at": "2026-10-12T06:00:00Z",
      "unless": { "probe": "backup", "value": "exit:0" }
    }
  ]
}
```

Values are `present`/`absent` for files, `status:<code>`/`unreachable` for HTTP,
and `exit:<code>`/`timeout` for commands (add `"output": true` to use the first
line of stdout instead). `"*"` in `notify` means any change. The first run
records a baseline and sends nothing unless a probe sets `"notifyInitial": true`.
Commands run directly, without a shell. The webhook URL can be the direct or
Tailscale URL. Failed deliveries retry, and a still-undelivered
event is re-sent with the same `Idempotency-Key` on the next run.

Use the `ada` command from the same Ada release as your server. Earlier
releases and the `ada` package on npm don't include `watch`, so if `ada watch`
reports an unknown command, that `ada` is too old.

- **Desktop app:** the app keeps its own launcher at `~/.t3/bin/t3`, or
  `%USERPROFILE%\.t3\bin\t3.cmd` on Windows (under your Ada home if you changed
  it). [The `ada` command](./install.md#the-t3-command) explains how to put it on
  your `PATH`.
- **Server without the desktop app:** use the standalone `ada` CLI built with
  the same release, not one installed from npm.

Run `ada watch /path/config.json --once` from a scheduler, or `ada watch
/path/config.json --interval 30` under any supervisor. Progress is kept next
to the config, in `config.json.state.json`.

Each state file is one watcher: it holds a single-writer lock while a run is in
progress, so overlapping scheduled runs skip safely instead of sending twice or
failing. A crashed run's lock is reclaimed automatically. The state file also
carries the watcher's identity, which is part of every `Idempotency-Key`. Don't
copy a state file to another host or machine; give each its own. To start fresh,
delete the state file.

Schedulers don't read your shell's `PATH`, so give them absolute paths for
both the `ada` launcher and the config. These examples use the desktop app's
launcher. Check them against your scheduler's own documentation before relying
on them:

- Linux: a cron line such as
  `* * * * * /home/me/.t3/bin/t3 watch /home/me/watch/config.json --once`, or a
  systemd user timer with the same command.
- macOS: a launchd agent with `ProgramArguments` of `/Users/me/.t3/bin/t3`,
  `watch`, `/Users/me/watch/config.json` and `--once`, and `StartInterval`
  `60`. launchd skips runs while the Mac sleeps.
- Windows, from Command Prompt (paths with spaces keep their inner `\"`
  quotes):

  ```bat
  schtasks /Create /TN t3-watch /SC MINUTE /TR "\"%USERPROFILE%\.t3\bin\t3.cmd\" watch \"C:\watch\config.json\" --once"
  ```

The command exits non-zero while an event is still undelivered, so schedulers
show the failure.

## Defaults and inheritance

Threads contains the model and workspace for new threads. Browser controls agent browser
access. Source control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Projects category, under Code, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there. When a project has several checkouts on one environment,
choose one in the scope line at the top to see or change only that checkout's settings.

Settings a repository can also declare in `t3.json`, such as the workspace for new threads,
resolve in one order: a project override, then the environment setting, then `t3.json`, then the
built-in default. Leave a setting on **Inherit** to let the next tier decide.
Browser access changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → Worktrees** under Advanced (with the project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `t3.json` of the branch being checked out
applies when the project and environment are both on **Inherit**.

## Worktree location

New worktrees go in the `worktrees` folder of the Ada home directory. To put them somewhere else,
such as another drive, set **Settings → Worktrees → Worktree location** to an absolute path like
`D:\worktrees` or `~/worktrees`. The setting is per machine. Existing worktrees stay where they
are, and cleanup covers both the default folder and the custom one.

## Fast worktree checkout on macOS

Fast worktree checkout is a beta. Turn it on for each Mac in **Settings → Labs → Fast worktree
checkout**. Ada then keeps a few recent checkouts of each repository in the `caches` folder of
the Ada home directory. A new worktree is cloned from one of them with APFS copy-on-write, which is
about twice as fast as writing every file and makes the first `git status` in it fast as well.
Turning it off deletes the cache.

The first worktree of a repository uses Git's normal checkout and fills the cache. It needs Git 2.42
or newer. Git's normal checkout is also used for worktrees on a different drive from the Ada home
directory, sparse checkouts, repositories whose attributes use filters such as Git LFS, and
repositories whose checkout settings changed.

## Light worktrees

Build caches inside a checkout, such as `.zig-cache`, are rebuilt and stored again in every new
worktree. Two `t3.json` fields keep worktrees small:

- `worktreeSharedPaths` links each listed folder in every new worktree to one folder per
  repository in the `caches` folder of the Ada home directory. The first link starts from a
  copy-on-write clone of the source checkout's folder when the filesystem supports it. Builds in
  any worktree reuse what the others compiled, whether they run from Ada, an agent, or your own
  terminal. List only caches whose tool allows several builds at once.
- `worktreeClonePaths` clones each listed folder from the source checkout into a new worktree
  before its setup script runs. Clones share disk blocks until a file changes, so they take
  almost no space. They need APFS on macOS or a filesystem with reflinks on Linux, such as Btrfs
  or XFS; elsewhere Ada skips them.

Both take Git-ignored, repository-relative folders. `.git`, `.t3`, and `.env` files are refused.
Ada keeps shared links out of `git status`, and removing or reclaiming a worktree leaves the
shared folder in place, so it only grows. Each shared folder is listed with its size under
**Settings → Maintenance → Cleanup → Last run**; **Clear** empties it, and the next build fills it
again. A build running in one of the repository's worktrees may fail while you clear it. A settle
script that deletes build output must not delete a shared path, because the cache belongs to every
worktree.

Examples by toolchain:

- **Zig:** share the local cache. Zig locks its manifests, so concurrent builds are safe.
  `{ "worktreeSharedPaths": [".zig-cache"] }`. Compiled Zig modules are reused across worktrees.
  As of Zig 0.17, steps that run external commands (`addSystemCommand`) are cached per checkout
  folder, so anything built from their output is rebuilt in each worktree.
- **Rust:** clone `target`, so the first build is incremental:
  `{ "worktreeClonePaths": ["target"] }`. Don't share `target`, because each build replaces the
  binaries another worktree runs. To share compiled crates, use
  [sccache](https://github.com/mozilla/sccache), whose cache is already global.
- **Go:** nothing to add. Go's build and module caches are already shared across checkouts.
- **uv:** nothing to add. uv's cache is global and new environments link to it, so a setup script
  running `uv sync` is fast and small.
- **Next.js:** clone the build cache: `{ "worktreeClonePaths": [".next/cache"] }`. Next.js does
  not document concurrent builds in one cache, so don't share it.
- **pnpm or npm:** clone `node_modules`, then keep `pnpm install` in the setup script. Some links
  in a cloned `node_modules/.bin` still point at the source checkout until the install fixes
  them.

## Storage cleanup

Open **Settings → Worktrees → Cleanup** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that project's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected project or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, after a thread settles, after
merging, or when they have no commits beyond the default branch and their thread is settled or
archived. Set settled retention to 0 days to remove a worktree at the next cleanup after
settlement. In repositories without remotes,
unchanged-worktree cleanup compares against the branch checked out in the project workspace;
if that checkout has a detached HEAD, the worktree is kept. Only Ada-managed worktrees are eligible.
Active sessions and shared worktrees prevent removal. **Keep worktrees with local changes** defaults
to **Uncommitted changes**, which protects tracked edits and untracked files but deletes ignored
files such as `.env` and build output. **Any local files** also protects ignored files other than
`node_modules`. **Edited tracked files** protects only tracked edits and allows untracked and
ignored files to be deleted. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires a merged pull request whose commits are included in the remote default
branch. A squash or rebase merge on GitHub also counts when the pull request targeted the default
branch and the worktree is still at the pull request's last commit.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Choose **Delete now** to run the enabled rules immediately. The latest results show which
worktrees were removed or kept and why, plus any failures.
Results also list folders in the worktree folder that no thread uses, with their sizes; cleanup never removes them, so remove them manually if you want.

To free a finished thread's worktree without enabling a policy, ask an agent connected through
Ada's MCP tools to reclaim it (`t3_reclaim_worktree`; a dry run only reports). The thread keeps
its history and branch, and its next turn recreates the checkout. Reclaiming also requires the
latest commit to be included in the remote default branch, so squash-merged branches are kept;
dependency installs and build output may be removed, other ignored files are kept. Every reason a checkout is kept is reported.

The inactive and settled retention periods also apply to the folders of
[threads without a project](./thread-sidebar.md#start-without-a-project). Those folders are not
Git repositories, so their files are deleted with them and cannot be recovered; the thread stays,
and its next turn starts in a new, empty folder. A folder is kept when it has a Git repository
anywhere inside it or when its thread has an enabled scheduled task. Every file in such a folder
counts as untracked, so only **Edited tracked files** removes a folder that holds anything other
than `node_modules`; the other two rules remove only empty folders. Folders that no thread uses
are listed here too.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Project icons

Select the project and open Project to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
Ada detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.
On mobile, use **Settings → Source control** to change selected environment defaults or project overrides.

Ada only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
