# Welcome wizard

T3 Code shows a setup flow when you open a new installation. Existing
workspaces skip this flow.

The hosted app at app.t3.codes does not open setup. With no computer connected,
it asks you to sign in to T3 Connect, then to run `npx t3 connect` on your
computer. From home, it adds compatible computers linked to your account and
opens the app.

Close setup while no import is running to go straight to the app. You can connect
computers and agents later from Settings, or open `/welcome` to run setup again.
Direct links, such as Settings, open normally before setup is done.

## Connect your computers

Select one or more computers to set up. If you opened T3 Code directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **T3 Connect** connects computers that are signed in to your account.
  [Install the CLI](./install.md#command-line) and run `t3 connect` on each
  computer you want to add, then start T3 Code or run `t3 serve` so the
  computer stays available.
- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `t3 serve`, then run `t3 pair --tailscale` and paste
  the pairing link. You can also run `t3 serve --host <address>` and use
  `t3 pair` when the server is already reachable on your network.

A computer marked **Client not supported** runs a T3 Code version that cannot
talk to this app. The message under its name says which side to update.

Saved computers and computers discovered through T3 Connect are selected by
default. Uncheck any you do not want to set up; this does not disconnect them.
Continue when your selected computers are connected. Setup checks
agents across the selected computers, then offers project import grouped by computer.

If T3 Code cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If T3 Code cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check your agents

T3 Code checks each selected computer for Claude Code and Codex. If an agent is
not installed or signed in, select its action to open a terminal with the
correct command ready to run. Install uses the vendor's own installer, which
keeps **Update now** working in Settings. Other providers can be enabled in
Settings.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

## Import your projects

T3 Code finds directories that Claude Code or Codex has used. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the
group shows the repository as `owner/name`. Clones with the same remote share
one group. Directories that are not git repositories sit under "Other folders".

The default selection includes git repositories active within the last 30 days
with at least three conversations. Use the checkboxes, or "Select all" and
"Select none", to change the selection. Linked worktrees of bare repositories
can be offered as separate projects. Other linked git worktrees, Codex scratch
directories under `Documents/Codex`, and anything under `Downloads` are not
offered.

A large or malformed history can reach the scan limit. T3 Code keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Codex and Claude conversations active within the last
30 days. You can continue those conversations in T3 Code.

Conversation import is best effort. T3 Code keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it shows the user messages
Codex itself shows, without the generated setup and IDE context, and answered
questions as question and answer. Older Codex conversations that never recorded
those messages keep their setup context. For Claude, slash commands appear as
typed and their local output is omitted. It reads one conversation at
a time and skips files larger than 4 GiB. It also skips a conversation when the
message text and metadata it keeps need more than 32 MiB of memory. Tool output
does not count toward that limit. It ignores malformed records and skips
unreadable or unparseable conversations.

Each import attempt reads up to 100 conversation files and 4 GiB per project,
with up to 100,000 input records. Run import again to continue a large batch.
Completed conversations are not imported again. You can continue without the
remaining history.

You can continue without configuring agents or importing projects, or return to an earlier step
using the setup progress bar. Navigation pauses while an import is running.
