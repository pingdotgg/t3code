# Muse Code

Muse Code is a beta integration and is disabled by default.

Muse Code runs on the machine hosting your selected environment. Install and sign
in there using the same account that runs T3 Code:

```bash
curl -fsSL https://dev.meta.ai/install.sh | bash
muse login
```

Use your Muse Code subscription account when signing in. T3 Code uses the host's
saved Muse credentials and ignores `META_API_KEY` when starting Muse. A saved API
credential can still select API billing; provider status does not verify your
subscription or billing method. See [Muse Code's official setup](https://developer.meta.com/ai/products/muse-code/).

In the web or desktop app, open **Settings > Providers**, choose the environment,
and enable **Muse Code**. If Muse is not on the server's `PATH`, set **Binary path**
to its executable. Refresh provider status after installing or signing in, then
choose Muse in a thread's model picker.

## Use Muse from another device

Connect that device to the environment through [remote access](./remote-access.md).
Muse runs with that host's login and works on that host's files. The connecting
device does not need Muse installed.

To run Muse on a second host, install Muse and T3 Code there, run `muse login`, and
enable Muse in that environment's provider settings. Connect to that environment
when you want work to run on the second host. Signing in on one host does not sign
in the other.

## Continue conversations from the CLI

Enable Muse before importing projects in the [welcome wizard](./welcome-wizard.md).
T3 Code can import recent Muse conversations from that host and continue them
when you send a message. Imported history includes visible user and assistant
text; tool activity and attachments stay in the original Muse history.

Finish or stop active conversations before importing. Conversations with
unavailable or truncated history may be skipped; background subagent sessions
are not imported as separate conversations.

## Models and access

The model list comes from Muse on the selected host. Choose a model and reasoning
effort in the thread's model settings. To refresh models on mobile, use
**Refresh models** in thread settings.

Install available Muse updates from **Settings > Providers**. Updates run on the
selected environment's host. Custom standalone binaries may need to be updated
on that host manually.

## Manage conversation context

Send `/compact` in an existing conversation to ask Muse to summarize its context.
Web and desktop also offer **Compact context** from the context meter. Muse may
decline compaction when there is nothing to summarize or the session cannot be
compacted; you can continue chatting afterward.

**Revert to this message** rewinds Muse's conversation along with T3 Code's
checkpoint. Muse keeps the original conversation and continues from a copy at
the selected point. Stop an active turn before reverting. Muse may reject a
point whose failed or interrupted turn was not committed, such as a failed
sign-in attempt.

If Muse reports lost event updates, resume to continue working. Muse retains its
saved conversation, but missing updates are not restored in the T3 Code chat.

## Current limitations

Muse does not offer a separate Plan mode in T3 Code. Muse skills and MCP servers
configured on the host remain available to Muse, but T3 Code does not
automatically connect its browser and pull request tools to Muse.
[Agent device access](./devices.md#agents-and-devices) is available through the
`agent-device` command line after you enable it and restart the agent session.

The Usage page and subscription quota indicators do not include Muse activity.
Install Muse and sign in on the host; in-app Muse installation and sign-in are
not available.

To stop using Muse in an environment, disable it in **Settings > Providers**.
This keeps the host's Muse login, thread history, and workspace files.
