# Antigravity

T3 Code runs Google's official Antigravity ACP agent on your selected environment.
Orbit installs and updates the Antigravity CLI; T3 Code finds it on the environment's `PATH`
and manages sign-in, separate from your terminal or IDE. Google controls
which models and account access are available through this agent.

## Set up Antigravity

On web or desktop, open **Settings > Providers**, choose the environment that runs
your project, and enable Antigravity. Choose **Sign in** and complete the browser
sign-in. Wait for T3 Code to confirm account access and load models before
starting a thread. You can also sign in from **Settings > Providers** in the
mobile app.

If Antigravity is not on the environment's `PATH`, Orbit has not installed it
there yet. Setup requires permission to operate the environment.

### Sign in from a remote device

Google returns to a `127.0.0.1` address. It can finish directly when your browser is
on the environment's machine. From another device, the final page will usually
fail to load because the sign-in listener is on the environment.

Copy the full return address, including everything after `?`, into the return URL
field in the client where you started sign-in, then choose
**Continue**. Keep the original address; do not replace it with the server's
hostname. Only that T3 Code sign-in session can finish the attempt. If it expires,
retry sign-in and use the new link.

The return URL contains a temporary sign-in code. Paste it only into the setup
field. A successful callback page alone does not confirm account access; wait for
T3 Code's confirmation.

### Other sign-in methods

Choose **Sign-in method** in the Antigravity provider settings:

| Method                     | Credentials                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Google account             | Personal Google sign-in in the browser                                                       |
| Gemini Enterprise          | Browser sign-in, GCP project, and GCP location                                               |
| Gemini API key             | API key; choose Connect without a browser                                                    |
| Agent Platform / Vertex AI | API key, or GCP project and location with Application Default Credentials on the environment |

The environment stores the Antigravity API key outside its settings file, and
clients only see whether one is saved. The agent uses the method and credentials selected for this instance;
ambient `GEMINI_API_KEY` and Google credential variables do not override them.
Changing the method stops the instance's sessions. Sign out before replacing an
account.

## The Antigravity CLI

Orbit installs and updates the Antigravity CLI on each environment. T3 Code shows
its version in provider settings and never installs, updates, or removes it.
To use another executable, set **Binary path**; leave it blank to use `agy` on
`PATH`.
On Windows, **Binary path** can also be a `.cmd` or `.bat` script that only sets
variables and then runs `agy_acp_server.exe` by its full path or a `%~dp0`-relative
path; keep `localharness_external.exe` beside that executable.

## Models and threads

The model list comes from your Antigravity account, including Claude and GPT models
when your plan has them. Pick a thinking level beside the model list in the model picker; it
shows only the levels the selected model supports. A resumed thread keeps its
selected model. If access to that model ends, select another available model
before continuing.

Antigravity creates empty `.gemini/skills` and `.agents/skills` folders in the
workspace when a session starts. Git does not track empty folders, so they never
appear in commits.

Use Antigravity's native `/plan` command for planning. Tool approvals follow [Permission modes](./permission-modes.md).
Questions with fixed choices still need one of the offered answers, even in
**Full access**.

On web and desktop, [Edit from here](./composer.md#edit-an-earlier-prompt) works with
Antigravity. Antigravity cannot rewind its own conversation, so the next turn
starts a fresh Antigravity session and T3 Code sends it the kept conversation,
without the turns you removed.

Manual context compaction is unavailable through Antigravity's ACP runtime, even
though its CLI has `/compact`. Send `/clear` when you need a fresh context.

### Skills and attachments

Put project skills in `.agents/skills`. T3 Code also reads `.gemini/skills` and the
legacy `.agent/skills` directory. Among these project locations, the first copy
wins in this order: `.gemini/skills`, `.agents/skills`, `.agent/skills`. See
[commands and skills](./composer.md#commands-and-skills) for invoking them.

Skills for every project go in `~/.gemini/config/skills` or
`~/.gemini/antigravity-cli/skills`. Antigravity does not read `~/.agents/skills`,
so a skill there only appears when the project itself is your home directory.

Antigravity receives images and audio directly, and reads PDFs and text files as
documents. With the managed runtime on macOS and Linux, an MP4 video up to 20 MiB
is sent as video to Gemini models. Other attachments, and videos for other models, are passed as a
saved file path for the agent to inspect with its tools.

### Subagents

Antigravity groups subagent activity into batches. Open a batch and select
**Subagent work** (**Work** on mobile) to read each child's role, prompt, and recent steps. This view
is read only: you cannot message or control individual subagents, and an idle
batch does not confirm that every child succeeded. If Antigravity did not record
which children a batch started, the view says so. See
[agent work](./thread-sidebar.md#inspect-agent-work) for where to inspect
activity.

## Accounts and removal

Add an Antigravity provider instance for each Google account in
**Settings > Providers** on web or desktop. Each has its own sign-in; the CLI is
shared on the environment.

| Action   | Effect                                                            |
| -------- | ----------------------------------------------------------------- |
| Disable  | Stops the instance's sessions and keeps its Google sign-in.       |
| Sign out | Stops the instance's sessions and removes its saved Google login. |

Both keep thread history and workspace files. Sending `/logout` by itself in
a thread signs out its instance, including stopping that instance's other sessions.
Sign out, then sign in again to replace an account.

## Run a native goal

When your Antigravity runtime offers `/goal`, send `/goal` followed by a verifiable
objective. Antigravity keeps working until it completes the goal or you cancel it.
An older 1.4.5 runtime has no `/goal`; once Orbit updates it, refresh provider status.

Use Stop to interrupt a running goal, then ask Antigravity to stop pursuing it
before starting more work. Ordinary follow-ups wait until the running turn ends.
T3 does not support Antigravity goal status, pause, resume, or clear commands.

## Check access and troubleshoot

Open **Usage > Limits** to see the remaining Gemini and shared Claude/GPT allowances
for Google sign-ins. Each group has separate five-hour and weekly limits and reset
times. Limits refresh with provider status and include usage outside T3 Code.

A server restart keeps your Google sign-in. The provider shows the saved account
until a session, a refresh, or a sign-out reports something new.

To check access and reload models, use **Refresh provider status** in web or desktop
provider settings, or **Refresh models** in mobile thread settings. If asked to
sign in again, use provider settings on web or desktop, or **Settings > Providers** on mobile.

If Google reports `SUBSCRIPTION_REQUIRED`, an account restriction, or a usage limit,
follow the provider's message and any retry time. See [Google's account plans][plans]
for eligibility.

[plans]: https://antigravity.google/docs/plans
