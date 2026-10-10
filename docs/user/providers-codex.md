# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in T3 Code.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers**. For a remote machine,
select that environment first. T3 Code handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in T3 Code.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

When reconnecting, choose the same account in T3 Code and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

T3 Code can use your installed Codex and its existing login. Run `codex login`
on the environment's machine to sign in. [Provider setup](./install.md#providers)
covers installation and custom configuration.

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, then select the account
from the thread's model picker. Compatible accounts can continue the same thread.
Connecting accounts through T3 Code leaves your CLI login unchanged.

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

## Recover exhausted stream retries

You can opt the selected environment into recovery when native Codex exhausts its own stream-disconnection retries. The server waits 30 seconds before continuing the existing conversation, then allows one more continuation after 60 seconds if that turn fails the same way. The two-attempt budget survives server restarts. Custom endpoints qualify only when Codex supplies the same structured failure evidence; other providers and unknown failures keep their manual continuation path.

The preference defaults to off and applies to every project in that environment. Ask an agent with full access in the selected environment to call `t3_environment_preferences_update` with `{ "recoverCodexStreamFailures": true }`. Read it back with `t3_environment_read`. There is currently no Settings toggle for this preference. To turn it off, call the same update with `false`; previously scheduled attempts are invalidated even if you enable it again later.

A pending attempt keeps the failed turn and its saved work. `t3_thread_read` reports the planned recovery time, attempt and state in that run's `streamRecovery` record, and an attempted continuation appears in thread activity. App-owned delegated tasks hold their final result while recovery is pending; the continuation keeps the same task and child conversation. Provider-native subagents do not get separate host recovery turns.

Stop, a newer instruction, changes to the model, provider or execution modes, completion, settlement, snoozing, archive, deletion, or a pending approval or question takes precedence. Recovery never answers an approval, unsnoozes a thread, switches accounts or models, or replays the original prompt. The continuation asks the agent to inspect completed actions before doing unfinished authorized work; the agent still needs to check those actions before repeating them.

Policy errors, safety-buffering notices, authentication, context and usage errors, overload, and client connection loss do not trigger this recovery. An unsupported failure stays visible for manual review or continuation.
