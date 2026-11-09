# Welcome page

T3 Code shows a Welcome page when you open a new installation. Existing
workspaces skip it. It shows what T3 Code found on the computer you are using,
on one page: your agents, projects from your Claude Code, Codex, and Pi history,
and the phone app. Only an agent is needed to start chatting.

To see the page again, go to **Settings → About → Welcome page** and select
**Open**. Direct links, such as Settings, open normally before setup is done.

The hosted app at app.t3.codes does not open the page. With no computer connected,
it asks you to sign in to T3 Connect, then to install T3 Code and run
`t3 connect` on your computer. From home, it adds compatible computers linked to your account and
opens the app. To add more computers later, use **Settings → Environments**.

If T3 Code cannot confirm the workspace during startup, it shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If T3 Code cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Agents

T3 Code lists the agents it found on the computer first, ready ones on top.
**Add more agents** lists every other agent T3 Code supports, A to Z, and opens by
itself when no agent is found:

- **Turn on** enables an agent that is off on this computer, including one only
  some projects use. T3 Code then checks whether it is installed and signed in.
- For Claude Code, **Install** or **Sign in** opens a terminal with the correct
  command ready to run. Install uses the vendor's own installer, which keeps
  **Update now** working in Settings.
- For Codex, **Set up** offers sign-in with your ChatGPT account or your own
  Codex CLI. **Use existing CLI** opens the terminal to install or sign in, and
  **Continue with ChatGPT** stays available until Codex is ready.
- Other agents, and agents that could not load, open their page in
  **Settings → Providers**.
- **Browse** opens the ACP Registry for more agents.

On the desktop app, when the folder of the `t3` command is not on your `PATH`,
**Add to PATH** adds one line to your shell's startup file.

The setup terminal uses the home directory and environment configured for the
provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

**Start** waits for one ready agent. Select **Start without an agent** to finish
without one.

## Phone

Select **Set up** to show QR codes for the App Store and Google Play. Then select
**Sign in to T3 Connect** and allow this computer when T3 Code asks, so the app can
reach it. Sign in to the app with the same account. If you are signed in but this
computer is not shared yet, select **Set up T3 Connect**. If T3 Connect is on but
the app cannot reach this computer, select **Check T3 Connect** to see why. On
builds without T3 Connect, or when your organization turns it off, pair the app
from **Settings → Sharing & access**.

## Projects

T3 Code finds directories that Claude Code, Codex or Pi has used. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the
group shows the repository as `owner/name`. Clones with the same remote share
one group. Directories that are not git repositories sit under "Other folders".

The page offers git repositories active within the last 30 days with at least
three conversations, already checked. Uncheck the row to start without them, or
select **Review all** to pick from everything found, with "Select all" and
"Select none". Linked worktrees of bare repositories
can be offered as separate projects. Other linked git worktrees, Codex scratch
directories under `Documents/Codex`, and anything under `Downloads` are not
offered.

A large or malformed history can reach the scan limit. T3 Code keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Claude, Codex and Pi conversations active within the last
30 days. You can continue those conversations in T3 Code. Pi is off by default:
select **Turn on** next to Pi, and the page looks for its sessions too. Pi sessions
are read from each enabled Pi provider's session directory, which follows
`PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` in its environment. A
Pi conversation imports its active branch, the one Pi reopens.

Conversation import is best effort. T3 Code keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so T3 Code does not remove user text. It reads one conversation at
a time and skips files larger than 4 GiB. It also skips a conversation when the
message text and metadata it keeps need more than 32 MiB of memory. Tool output
does not count toward that limit. It ignores malformed records and skips
unreadable or unparseable conversations.

Each import attempt reads up to 100 conversation files and 4 GiB per project,
with up to 100,000 input records. Run import again to continue a large batch.
Completed conversations are not imported again. You can continue without the
remaining history.

You can start without importing. While an import runs, T3 Code stays on the
Welcome page. If you quit, open the Welcome page again to import the rest.
