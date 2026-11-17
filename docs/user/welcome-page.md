# Welcome page

Ada shows a Welcome page when you open a new installation. Existing
workspaces skip it. It shows what Ada found on the computer you are using,
on one page: your agents, projects from your Claude Code, Codex, and Pi history,
and the phone app. Only an agent is needed to start chatting.

To see the page again, go to **Settings → About → Welcome page** and select
**Open**. Direct links, such as Settings, open normally before setup is done.

A hosted web app does not open the page. With no computer connected,
it asks you to add one with a pairing link. The computer must be reachable from that
browser at an HTTPS address, such as its [Tailscale HTTPS](./remote-access.md#tailscale-https)
address. To add more computers later, use **Settings → Environments**.

If Ada cannot confirm the workspace during startup, it shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If Ada cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Agents

Ada lists the agents it found on the computer first, ready ones on top.
**Add more agents** lists every other agent Ada supports, A to Z. When no agent
is found, it reads **Set up an agent** and opens by itself:

- **Turn on** enables an agent that is off on this computer, including one only
  some projects use. Ada then checks whether it is installed and signed in.
- For Claude Code, **Install** or **Sign in** opens a terminal with the correct
  command ready to run. Install uses the vendor's own installer, which keeps
  **Update now** working in Settings.
- For Codex, **Set up** offers sign-in with your ChatGPT account or your own
  Codex CLI. **Use existing CLI** opens the terminal to install or sign in, and
  **Continue with ChatGPT** stays available until Codex is signed in.
- When Ada knows an installed version does not work with it, **Update** opens
  the agent in **Settings → Providers**, which shows the version to use and updates it
  when it can.
- Other agents, and agents that could not load, open their page in
  **Settings → Providers**.
- **Browse** opens the ACP Registry for more agents.

On the desktop app, when the folder of the `ada` command is not on your `PATH`,
**Add to PATH** adds one line to your shell's startup file.

The setup terminal uses the home directory and environment configured for the
provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

**Start** waits for one ready agent. Select **Start without an agent** to finish
without one. Checked projects are still imported.

## Phone

Ada's mobile app is not in the App Store or Google Play yet, so the welcome page
does not offer phone setup. To pair a phone running a
[test build](./install.md#mobile-app), create a code in
**Settings → Sharing & access**. The phone must reach this computer over your local
network or Tailscale; see [remote access](./remote-access.md).

## Projects

Ada finds directories that Claude Code, Codex or Pi has used. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the
group shows the repository as `owner/name`. Clones with the same remote share
one group. Directories that are not git repositories sit under "Other folders".

The page offers git repositories active within the last 30 days with at least
three conversations, already checked. Projects already in Ada are not checked
again. Uncheck the box to start without them, or
select **Review all** to pick from everything found, with "Select all" and
"Select none". Linked worktrees of bare repositories
can be offered as separate projects. Conversations in other linked git worktrees
count toward their main checkout, so a repository is offered even if you only
worked in its worktrees. Codex scratch directories under `Documents/Codex`, and
anything under `Downloads` are not offered.

A large or malformed history can reach the scan limit. Ada keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Claude, Codex and Pi conversations active within the last
30 days. You can continue those conversations in Ada. Pi is off by default:
open **Add more agents** and select **Turn on** next to Pi, and the page looks for
its sessions too. Pi sessions
are read from each enabled Pi provider's session directory, which follows
`PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` in its environment. A
Pi conversation imports its active branch, the one Pi reopens.

Conversation import is best effort. Ada keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so Ada does not remove user text. It reads one conversation at
a time and skips files larger than 4 GiB. It also skips a conversation when the
message text and metadata it keeps need more than 32 MiB of memory. Tool output
does not count toward that limit. It skips a conversation with more than 100,000
records every time, so opening the page again does not import it. It ignores
malformed records and conversations with no messages, such as a session opened
in an editor but never used. It skips unreadable or unparseable conversations.

Each import attempt reads up to 100 conversations and 4 GiB per project.
Conversations with no messages count toward the 4 GiB but not the 100. To
continue a large batch, open the Welcome page again and pick the project in
**Review all**. Completed conversations are not imported again. You can continue
without the remaining history.

You can start without importing. While an import runs, Ada stays on the
Welcome page. If you quit, open the Welcome page again from **Settings → About**; the
projects you started stay checked.
