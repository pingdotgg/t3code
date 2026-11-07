# Codex

Use a Codex CLI account or ChatGPT subscription sharing to code in T3 Code.

## Sign in with Codex CLI

In **Settings > Providers**, choose **Add provider**, then **Codex** and **Sign in
with Codex CLI**. Name the account and continue to sign-in. T3 Code stores this
account's login separately. The account shares your Codex skills, plugins, and
thread history.

If Codex is unavailable, install it from the account's setup panel before signing
in. T3 Code installs it on the selected environment's machine.

For a T3-managed installation, use **Refresh provider status** in **Settings >
Providers** to check for the latest stable Codex release, then choose **Update
Codex** when offered. On mobile, the update is offered under **Provider accounts**.
Updates install only when requested; a failed update keeps the previous runtime.

Choose **Device code** to sign in from any device. Enter the displayed code on the
OpenAI page and choose your account. Choose **Browser on server machine** to sign
in with a browser on the machine running the T3 Code environment.

Use **Open browser** if the sign-in page does not open. You can cancel and retry,
change accounts, or sign out in the provider's settings. Signing out stops this
account's running threads and keeps their history. On mobile, open **Provider
accounts** to sign in or out of an account you have configured.

## Connect with ChatGPT sharing

Connect during onboarding or in **Settings → Providers**. For a remote machine,
select that environment first. T3 Code handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in T3 Code.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

Fast and Ultrafast speeds are unavailable with this connection. To use the speed
options your account supports, [use an existing Codex login](#use-an-existing-codex-login).

When reconnecting, choose the same account in T3 Code and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

Choose **Use existing Codex CLI** when adding the provider to use the CLI's current
login and settings. Run `codex login` on the environment's machine to sign in.
[Provider setup](./install.md#providers) covers installation and custom configuration.

## Use Traex bridge

Run traex-bridge at `127.0.0.1:8317` on the selected environment's macOS or Linux
machine. Store its API key in `~/.traex-bridge/api-key` on that machine.
In **Settings > Providers**, choose **Add provider**, then **Traex**.
The preset uses Codex from that machine's PATH or a copy T3 Code has installed.
To use another executable, set its path in **Config**.

Traex stores its sessions and configuration in a separate Codex home.

Running `codex login` does not change a managed ChatGPT connection. In
**Settings > Providers**, add a Codex instance, choose **Configure manually**,
and complete the wizard. Then select that instance from the thread's model
picker. See [Use multiple accounts](#use-multiple-accounts).

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, then select the account
from the thread's model picker. Compatible accounts can continue the same thread.
Connecting accounts through T3 Code leaves your CLI login unchanged.

To show your accounts as one entry in the model picker, pool them in **Settings >
Labs > Zack > Account pools**. Pooled ChatGPT accounts that share a Codex home resume the same
thread natively when a turn moves between them. An account with its own Codex home,
such as Traex, continues from a summary of the conversation instead.

### Multiple CLI logins

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

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
