# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Dictate a draft

On web and desktop, select a Codex provider and use the microphone in the
composer. Dictation uses that provider's ChatGPT login and sends your audio to
OpenAI. It requires a Codex CLI version with experimental realtime support
(tested with 0.154.0); API-key accounts are not supported.

Words appear directly in your editable draft as they are transcribed. Move the
cursor or select text to put the next words there; you can also type corrections
while speaking. Say "question mark", "period", "full stop", "comma", or
"exclamation mark" to insert punctuation. Stop waits briefly for the last words;
cancel stops immediately and keeps text already inserted. You can switch apps
while speaking. Nothing is sent as a chat message automatically.
Recordings finish after five minutes. Keep T3 open and the computer awake;
closing the thread or losing the connection interrupts dictation.

Say "new line" or "new paragraph" to break up your draft, "bullet point" for a
bullet, and "number one", "number two", etc. for numbered items. "Scratch that"
removes the last sentence in the current dictated insertion; it does not undo
text you typed or earlier insertions after moving the cursor. "Um" and "uh" are
removed locally when hesitation cleanup is enabled. Other words, including
"actually", are kept as spoken.

In **Settings > General > Dictation**, select an environment to turn these
commands or hesitation cleanup off, or manage custom word replacements and
snippets. A custom word maps a misheard phrase to its preferred spelling; a
snippet expands a spoken shortcut into saved text. These settings are shared
by clients connected to that environment.

Open the arrow beside the microphone to choose **Dictation only** (the default)
or **Polish after dictation**. With polish on, grammar cleanup runs in the
background after Stop and applies automatically if the draft is unchanged.
Use **Undo polish** in the microphone menu to restore the original. You can keep typing, dictating,
or sending immediately; a late result cannot overwrite your edits. Turn
polish off from the same menu or **Settings > General > Dictation**.

Polish uses a separate Codex request and may take a few seconds; dictation
never waits for it.

## Use multiple accounts

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
