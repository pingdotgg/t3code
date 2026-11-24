# Antigravity

T3 Code runs Google's official Antigravity ACP agent on your selected environment.
T3 manages its own CLI installation and sign-in, separate from your terminal or IDE. Google controls
which models and account access are available through this agent.

## Set up Antigravity

On web or desktop, open **Settings > Providers**, choose the environment that runs
your project, and enable Antigravity. Install its runtime there, then choose
**Sign in** and complete the browser sign-in. Wait for T3 Code to confirm
account access and load models before starting a thread. Once the runtime is installed,
you can also sign in from **Settings > Providers** in the mobile app.

Installation continues if you leave settings or reconnect. Setup requires
permission to operate the environment; update an older server if it does not offer
Antigravity setup.

### Sign in from a remote device

Google finishes on an Antigravity page that shows a code. Paste that code, or the
page's full address, into the code field in the client where you started sign-in.
This works the same from any device.

The code is temporary. Paste it only into the setup field. The page alone does not
confirm account access; wait for T3 Code's confirmation.

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

## Runtime installation

Managed installation supports Apple Silicon and Intel macOS, Linux x64 or ARM64
with glibc or musl, and Windows x64 or ARM64. Allow at least 1.25 GiB of free disk
space for downloading and staging an update.

### Use a manual installation

Install [Antigravity CLI](https://antigravity.google/docs/getting-started) on the environment.
Set **Binary path** to its `agy` executable and update it yourself.
Leave the field blank to use the managed runtime, or a compatible executable on
`PATH` if no managed runtime is installed.

## Update the managed runtime

In web or desktop provider settings, choose **Update Antigravity** when an update
is available. T3 checks Google's CLI release channel while provider update checks
are enabled. Installing or reinstalling also checks that channel. Updates keep
your profile and existing runtime available if the new release fails validation.

T3 needs Antigravity 1.5 or newer and recommends 1.5.12 or newer. Sessions do not
start on an older runtime: update the managed runtime here, or update the executable
a custom binary path or `PATH` points at. You may need to sign in again after
updating from a runtime older than 1.5. Threads already running finish with their
original runtime; new sessions use the updated release. Custom binary paths keep
using the executable you selected.

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
When Antigravity asks a question, pick one of its options or type your own reply.
Questions still need an answer, even in **Full access**.

On web and desktop, [Edit from here](./composer.md#edit-an-earlier-prompt) works with
Antigravity. Antigravity cannot rewind its own conversation, so the next turn
starts a fresh Antigravity session and T3 Code sends it the kept conversation,
without the turns you removed.

Use `/compact` to summarize a long conversation when your Antigravity runtime
offers that command. If it is unavailable, update Antigravity in provider settings
or send `/clear` when you need a fresh context.

### Skills and attachments

Put project skills in `.agents/skills`. T3 Code also reads `.gemini/skills` and the
legacy `.agent/skills` directory. Among these project locations, the first copy
wins in this order: `.gemini/skills`, `.agents/skills`, `.agent/skills`. See
[commands and skills](./composer.md#commands-and-skills) for invoking them.

Skills for every project go in `~/.gemini/config/skills` or
`~/.gemini/antigravity-cli/skills`. Antigravity does not read `~/.agents/skills`
on its own; to share a folder like that one, list it in `~/.gemini/config/skills.json`
(or a project's `.agents/skills.json`), and T3 Code shows the skills it declares,
honoring `inherits`, `include_only`, and `exclude`.

Antigravity receives images and audio directly, and reads PDFs and text files as
documents. Other attachments, including videos, are passed as a saved file path for
the agent to inspect with its tools.

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
**Settings > Providers** on web or desktop. Each has its own sign-in; downloaded
runtimes are shared on the environment.

| Action                    | Effect                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| Disable                   | Stops the instance's sessions and keeps its Google sign-in.       |
| Sign out                  | Stops the instance's sessions and removes its saved Google login. |
| Remove downloaded runtime | Removes the shared installation and keeps Google credentials.     |

All three keep thread history and workspace files. Sending `/logout` by itself in
a thread signs out its instance, including stopping that instance's other sessions.
That needs a client allowed to manage providers, and it has to be your own message:
`/logout` from an agent or a scheduled task is refused.
Sign out, then sign in again to replace an account.

Before removing a managed runtime, disable its instances and cancel any active
installation. Clear any explicit binary path pointing into that runtime. Removal
is refused while the runtime is in use.

## Run a native goal

When your Antigravity runtime offers `/goal`, send `/goal` followed by a verifiable
objective. Antigravity keeps working until it completes the goal or you cancel it.

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
