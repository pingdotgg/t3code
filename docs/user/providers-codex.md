# Codex

Use a Codex CLI account or ChatGPT subscription sharing to code in T3 Code.

## Use hosted inference accounts

Choose **Settings > Providers > Inference accounts** to sign in on one host and run Codex threads on environments paired over Tailscale or your trusted LAN. Each thread keeps its workspace and tools on the environment where it runs. [Host and share inference accounts](./providers-claude.md#host-and-share-inference-accounts)

## Connect with ChatGPT sharing

Connect during onboarding or in **Settings → Providers** (select your target environment first for remote machines). T3 Code manages the Codex runtime and signs you in via OpenAI.

- Manage shared usage and credits through **Manage usage** in T3 Code.
- **Remote sign-in**: If sign-in doesn't return automatically, paste the full `localhost` redirect URL into the sign-in panel.
- **Speed options**: Fast and Ultrafast speeds are not available through ChatGPT sharing—[use an existing Codex login](#use-an-existing-codex-login) instead.
- Disconnecting stops running threads while preserving history.

## Use an existing Codex login

Choose **Use existing Codex CLI** when adding the provider to use the CLI's current
login and settings. Run `codex login` on the environment's machine to sign in.
[Provider setup](./install.md#providers) covers installation and custom configuration.

## Use Traex bridge

Run traex-bridge at `127.0.0.1:8317` on the Mac or Linux machine that hosts it.
Store its API key in `~/.traex-bridge/api-key` on that machine.
In **Settings > Providers**, choose **Add provider**, then **Traex**.
The preset uses Codex from that machine's PATH or a copy T3 Code has installed.
To use another executable, set its path in **Config**.

To share the bridge, turn on **Share inference with paired environments** on its host. Connect the host and the environment where you run threads to the same T3 client once, using connections that can manage providers. T3 discovers the bridge and saves the route. The client can then disconnect from the host. The picker offers Traex while a local or shared bridge serves models, and your thread keeps its workspace on its original environment.

Traex stores its sessions and configuration in a separate Codex home.

## Allow more time for provider checks

If an authenticated Codex installation reports “Timed out while checking Codex
app-server provider status,” set `T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` in the
T3 server's environment and restart it. See [Provider check timeouts](./install.md#provider-check-timeouts)
for configuration and other providers.

## Generate images

Codex can generate images directly in a T3 Code thread when your Codex version,
model, and account support native image generation.

If Codex reports that its image tool is unavailable, image generation may be
disabled in its configuration. In **Settings → Providers**, edit your existing
Codex provider and add this to **Launch arguments**, keeping any other arguments:

```text
-c features.image_generation=true
```

This enables the feature for that T3 Code provider without changing your shared
Codex configuration. You do not need another provider instance or a separate image
API key. The flag does not add image support to an unsupported model or account.

Launch arguments apply to Codex sessions started after you save them. Start a new
thread with the same Codex provider and ask it to generate an image. The completed
image appears in the thread.

## Use multiple accounts

Add accounts on the inference host, then turn on **Inference routing** for Codex on each environment that needs them. Threads keep using the normal Codex provider and model names. While the proxy is on, other Codex accounts on that environment are hidden; turn it off to use an individual CLI login again. [Host and share inference accounts](./providers-claude.md#host-and-share-inference-accounts)

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Use Mac apps

If your Codex instance already has native Computer Use configured and enabled,
ask it to work in a Mac app, such as Calculator. Computer Use controls the server
environment's Mac, even when you connect from another computer or your phone.
Native permissions and confirmation requests still apply.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Sign in to an MCP server

When an MCP server you added to Codex needs you to sign in, the thread shows a notice with
**Sign in**; on mobile, tap the notice. Approve access on the page it opens. Your browser then goes
to a page that may not load, especially when Codex runs on another machine: copy that page's
address, paste it into T3 Code, and choose **Finish sign-in**. Codex reconnects the server in that
thread and keeps the sign-in for other threads on the same Codex instance; an instance with its own
home, such as a second account, may need to sign in separately. Signing in needs permission to
manage providers.

## Use the OpenAI Chrome extension

Connecting ChatGPT in **Settings → Providers** signs in the Codex provider.
Using your signed-in Chrome profile through the extension requires a browser
connection for the current Codex thread.

If a T3 Code thread reports `The browser access host is unavailable`, its browser
host is unavailable; this does not identify an extension connection failure.
For a task that requested Chrome, follow [OpenAI's setup guide](https://learn.chatgpt.com/docs/chrome-extension),
then select Chrome in a Codex chat in the ChatGPT desktop app.
If the task runs on a remote environment, `localhost` in the desktop browser
refers to your computer. Forward the remote page's port or use a URL reachable
from your computer before repeating the task. Connecting to T3 Code through a
relay or tunnel does not by itself expose that page. T3 Code's built-in browser
preview uses its own browser session.

## Use Daybreak

Models with cyber access programs show a Cyber Access option in the model
options. It starts on Standard, or on Daybreak when `config.toml` in your Codex
home sets `daybreak = true` or the model only runs under Daybreak. Your choice carries
over to new threads. Custom models do not offer it. If Codex rejects a turn
because your login lacks the program, switch Cyber Access back to Standard or
sign in to Codex with an account that has it.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
