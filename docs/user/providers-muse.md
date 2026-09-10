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

## Models and access

The model list comes from Muse on the selected host. Choose a model and reasoning
effort in the thread's model settings. To refresh models on mobile, use
**Refresh models** in thread settings.

Install available Muse updates from **Settings > Providers**. Updates run on the
selected environment's host. Custom standalone binaries may need to be updated
on that host manually.

Muse does not offer a separate Plan mode in T3 Code. Some Muse releases reject
manual context compaction; if that happens, you can continue chatting or start a
new thread.

To stop using Muse in an environment, disable it in **Settings > Providers**.
This keeps the host's Muse login, thread history, and workspace files.
