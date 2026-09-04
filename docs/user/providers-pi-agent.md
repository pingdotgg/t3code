# Pi Agent (Early Access)

Pi Agent is an Early Access provider for users who already have the Pi coding
agent installed on the machine running T3 Code. T3 Code does not download,
install, update, or sign in to Pi. The provider starts Pi in its RPC mode and
reads the models, thinking levels, and slash commands that Pi reports.

## Setup

Open **Settings** → **Providers** on the environment where Pi is installed,
choose **Add provider** → **Pi Agent**, and enable the instance. Leave
**Binary path** as `pi` when the executable is on the server's `PATH`; set the
absolute path when Pi is installed elsewhere.

Each Pi instance can use its own profile and session directory:

- **Agent directory** maps to `PI_CODING_AGENT_DIR` and keeps Pi configuration,
  credentials, and extensions separate.
- **Session directory** is passed to Pi as `--session-dir` and keeps session
  files separate.

Relative Agent and Session directory values are resolved from the T3 Code
server directory, so the same instance keeps one profile and usage history
when it is used from different projects. Absolute paths and `~` paths are also
supported.

Add another Pi Agent instance when you need different profiles or model
catalogs. T3 Code gives every instance its own RPC process and remembers the
instance with the thread that uses it.

T3 Code launches your installed Pi executable rather than embedding Pi's SDK.
Pi therefore continues to load its extensions, packages, skills, prompt
templates, custom providers, credentials, and other profile configuration from
the selected Agent directory. Full Access sessions also pass Pi's `--approve`
flag so trusted project-local resources can load for that run.

T3 Code only checks that the configured binary runs and asks Pi's RPC endpoint
for metadata. If the status says that Pi was not found, install Pi on the
server or correct **Binary path**, then refresh provider status.

## Permissions

Pi Agent currently supports **Full Access** only. Pi's RPC protocol does not
provide a policy bridge for T3 Code to enforce read-only, approval-required, or
auto-accept modes. T3 Code therefore offers only Full Access in its permission
menus and rejects sessions requested with another mode. Review Pi's own
configuration and extensions before starting a session.

Pi can still display its native confirmation and input dialogs through T3 Code.
Those dialogs are requests from Pi; they do not turn a restricted T3 Code mode
into a supported Pi mode.

Extensions that use Pi's RPC-native `select`, `confirm`, `input`, or `editor`
requests appear as T3 questions or confirmations. Arbitrary terminal widgets
built with `ctx.ui.custom` are TUI-only and cannot be transported through Pi's
RPC protocol; an extension should provide its own non-TUI fallback for those.

## Models and commands

The model picker, `/` command menu, and `$` skill menu use Pi's live RPC
inventory. Selecting a Pi skill from `$` sends Pi its native `/skill:name`
command, so Pi loads the skill from the configured Agent directory rather than
T3 Code copying or interpreting it. Changing providers, profiles, skills, or
extensions outside T3 Code may change those lists. Refresh the provider status,
or reconnect the environment, after such a change. Thinking levels are exposed
as the model's **Thinking** option when Pi reports them.

The **Usage** page reads Pi's session JSONL files from every configured Pi Agent
instance, deduplicating instances that share a Session directory. If an
instance has no override, T3 Code uses Pi's standard
`PI_CODING_AGENT_SESSION_DIR` and Agent directory defaults. Token totals and
costs come from Pi's own recorded usage, including provider-reported prices for
custom models.

Pi Agent does not currently provide T3 Code's structured text-generation
operations for commit messages, pull-request text, branch names, or thread
titles. Select another provider for those actions.

## Sessions and troubleshooting

Stopping a thread stops its Pi RPC session. Existing Pi session files remain in
the configured session directory, so a later session can resume when Pi and
the selected profile expose the same session. A provider instance being
disabled stops new sessions but does not delete its profile or session files.

If a session fails to start:

1. Run the configured binary with `--version` on the T3 Code server.
2. Confirm the Agent directory and Session directory are readable and belong
   to the account running T3 Code.
3. Confirm the binary supports `--mode rpc` and `--session-dir`.
4. Refresh provider status after correcting the configuration.

Pi Agent is Early Access. Its RPC inventory and event details can change with
the Pi version; keep Pi updated according to its own documentation and report
provider failures with the Pi version and T3 Code server logs.

Pi Agent support is independent of the ACP Registry placeholder in T3 Code.
Generic ACP Registry providers remain a separate future feature.
