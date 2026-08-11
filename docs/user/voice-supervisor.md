# Voice Supervisor

Voice Supervisor lets you talk to T3 Code about work across the environments known to your current
client. It uses OpenAI Realtime for the voice conversation, but the work it supervises is
provider-neutral: the same session can inspect T3 threads running Codex, Claude, Cursor, Grok, or
OpenCode and propose actions for eligible live threads.

Voice Supervisor is currently available in the web and desktop apps only.

## Set Up Voice

1. Open **Settings** → **Voice**.
2. Choose the environment that should host the voice credential.
3. Enter an OpenAI API key and choose **Save key**.
4. Open Voice Supervisor, choose a host environment and voice, then choose **Start voice**.
5. Allow microphone access when your browser or operating system asks.

The settings page never requests microphone access or starts a session. Only the explicit **Start
voice** action does that.

The selected host environment must be connected, up to date, and advertise Realtime voice
support. It supplies the short-lived session credential, but it does not limit which environments
known to the current client the supervisor can discuss.

You can also set `OPENAI_API_KEY` in the host environment's process instead of storing a key from
Settings. A stored key takes precedence. Removing it makes the environment fall back to
`OPENAI_API_KEY`, if present. The long-lived key is write-only from the client: T3 reports whether
one is configured and where it came from, but never returns its value.

Managing a stored key requires `access:write` permission. If a remote session does not have that
permission, reconnect with an appropriate link or configure `OPENAI_API_KEY` on the environment
host.

## Open the Panel

Voice Supervisor is global, so it stays available as you move between projects and threads. Open
or hide it from any of these entry points:

- the floating microphone launcher in the lower-right corner;
- **Voice** in the main sidebar or Settings sidebar;
- **Toggle voice supervisor** in the Command Palette;
- a custom shortcut assigned to `voice.toggle` under **Settings** → **Keybindings**.

There is no default shortcut for `voice.toggle`.

Choose the host environment and voice before starting. Those selectors stay locked while a
session is connecting or active. Marin is the default voice; Alloy, Ash, Ballad, Coral, Echo,
Sage, Shimmer, Verse, and Cedar are also available.

## Session Controls

- **Mute** stops sending microphone audio without ending the session or releasing microphone
  capture. **Unmute** resumes sending it.
- **Stop** ends the session and releases its microphone capture, audio, and network resources.
- **Hide** closes only the panel. It does not stop or mute an active session. Use **Mute** before
  hiding if you do not want to send microphone audio, or **Stop** to release capture and end the
  session.

The floating launcher indicates connecting, listening, muted, failed, and pending-confirmation
states. T3 also mutes the microphone automatically while tool work or a local confirmation is in
progress, then restores the mute state you chose.

The panel shows a bounded recent transcript and activity feed. Starting a new voice session resets
that history; it is not a durable coding thread. Your spoken transcript is produced by a separate
input-transcription stream (`gpt-4o-mini-transcribe`) from the Realtime conversation model
(`gpt-realtime-2.1`). It is a useful display transcript, not a record of the model's exact internal
interpretation, and transcription can fail independently of the voice conversation.

## What the Supervisor Can Do

The supervisor has exactly eight tools:

| Tool                 | What it does                                                                  | Local confirmation |
| -------------------- | ----------------------------------------------------------------------------- | ------------------ |
| `list_active_work`   | Lists known threads that still have active or actionable work                 | No                 |
| `list_projects`      | Lists projects across the current client's known environments                 | No                 |
| `list_threads`       | Lists non-archived threads across the current client's known environments     | No                 |
| `get_thread_summary` | Reads a bounded status summary and current plan step                          | No                 |
| `open_thread`        | Opens the exact thread in your current client                                 | No                 |
| `start_thread`       | Prepares a new thread with the current T3 model, mode, and workspace defaults | Yes                |
| `send_follow_up`     | Prepares an instruction for an existing thread                                | Yes                |
| `interrupt_thread`   | Prepares an interrupt for a thread's active turn                              | Yes                |

Voice Supervisor has no direct file, terminal, approval, user-input, delete, archive, or restore
tools, and it cannot return full thread histories. A locally confirmed `start_thread` or
`send_follow_up` sends the prepared instruction to the target coding agent, which retains its
normal tools and configured permission mode. Any later provider approval or user-input prompt
remains separate and cannot be handled by Voice Supervisor.

## Confirming Changes

Starting a thread, sending a follow-up, and interrupting a thread never execute from the model's
tool call alone. T3 shows a local confirmation card with the exact target and action. Start-thread
cards also show the title, complete instruction, model, permission and interaction modes,
workspace choice, base branch when applicable, and whether the setup script will run.

Choose **Confirm** to execute or **Deny** to cancel. When the confirmation card itself has focus,
Enter confirms it; when focus is anywhere in the card, Escape denies it. Elsewhere in the panel,
Escape only hides the panel and the pending proposal remains. Saying “yes” to the voice model is
not a local confirmation.

Immediately before execution, T3 checks that the same environment and target are still connected,
live, and at the version captured when the proposal was prepared. A disconnected, missing, or
changed target is rejected instead of redirecting the command somewhere else. Confirmations are
one-shot and expire quickly.

## Similar Names and Multiple Environments

Project and thread labels include their environment label. Behind those labels, T3 gives the voice
model short-lived opaque handles that bind to one exact environment, target, and version. Raw
environment, project, and thread IDs are not exposed to the model.

Read tools can include cached shell snapshots from stale or disconnected environments when those
snapshots remain in the current client's catalog. Their bounded labels, availability, and status
may be sent to OpenAI. Current plan text is returned only after `get_thread_summary` revalidates a
live thread. Mutating actions still require the exact target to be live, connected, and unchanged
when locally confirmed.

If two environments produce the same display name, T3 returns bounded candidates instead of
guessing. A partial name also returns candidates even when it currently has only one match. The
supervisor must select an opaque handle before it can propose a change.

## Remote and T3 Connect Sessions

Voice works with connected local, LAN, SSH, Tailscale, and T3 Connect environments. The microphone
and speaker belong to the web or desktop client where you press **Start voice**; the selected
environment host does not need a microphone.

The client requests a short-lived credential through the selected environment using the same
authenticated connection as other T3 operations. It then sends microphone audio and receives
response audio directly over WebRTC. The T3 environment and T3 Connect do not proxy those audio
streams. Tool reads use the current client's environment catalog, while confirmed commands route
to the exact live environment that owns the project or thread. `open_thread` navigation stays local
to the current client. Compact tool results return to OpenAI over the Realtime data channel.

For Voice Supervisor in a browser, the page must be a secure context, normally HTTPS or localhost,
because browser microphone capture requires it. A plain HTTP page opened from another device may
support ordinary T3 controls, but Voice Supervisor cannot capture the microphone there. Prefer the
desktop app, `https://app.t3.codes`, or another trusted HTTPS endpoint.

## Cost, Data Flow, and Privacy

OpenAI bills Realtime API usage to the account behind the configured API key. This usage is
separate from ChatGPT, Codex, and other provider subscriptions, and T3 does not enforce a spending
budget for the session.

When you start voice:

1. The selected T3 environment uses the long-lived API key only to request a short-lived OpenAI
   client secret. That request sends OpenAI a stable, hashed pseudonymous identifier derived from
   the environment ID for safety tracking.
2. The web or desktop client uses that secret to connect directly to OpenAI, sends microphone
   audio, and receives response audio directly over WebRTC.
3. Microphone audio, the voice conversation, and the bounded work context returned by supervisor
   tools are processed by OpenAI. That context can include cached labels, availability, and status
   from stale or disconnected environments known to the current client. Current plan text is sent
   only after a live thread is revalidated.
4. Normal T3 environment connections carry credential requests, bounded work reads, and confirmed
   commands, but not local `open_thread` navigation or the WebRTC audio streams. Compact tool
   results travel to OpenAI over the Realtime data channel.

The model-facing tool results omit dedicated or raw workspace-path fields, internal
environment/project/thread IDs, and full histories. They contain bounded display labels,
availability and work status, current plan-step text when available, opaque handles, and compact
action results. T3 does not scrub user-authored labels or plan text, so those fields may themselves
contain sensitive content. Review OpenAI's current API pricing and data-control terms for the API
account you use.

## Limits and Troubleshooting

- List tools return at most 20 items at a time. Long labels, summaries, transcripts, and activity
  are bounded or truncated.
- Each web or desktop client, including each browser tab, owns at most one active voice session.
  Multiple clients or tabs can each run their own session. Within one session, only one
  tool-response batch is active at a time. A mutating proposal may wait for one local confirmation;
  identical response replays are ignored, while overlapping work, reused tool-call IDs, or
  conflicting replays fail closed.
- Target handles normally expire after about two minutes and confirmation proposals after about
  30 seconds. Ask the supervisor to list the work again if a target or confirmation expires.
- Startup negotiation and configuration time out instead of hanging. The microphone permission
  prompt itself has no T3 timeout, so you can respond to the browser or operating-system dialog.
- Voice does not automatically reconnect after a failed or closed session. Correct the displayed
  problem and choose **Start voice** again.

Common failures:

- **Voice is unsupported:** update the selected environment's T3 server. Older servers do not
  advertise the required capability.
- **No key, rejected key, or model unavailable:** check the selected environment under
  **Settings** → **Voice** and verify that the API account can use OpenAI Realtime.
- **Microphone unavailable or blocked:** allow microphone access for T3 Code or the browser in
  system settings, then retry.
- **Voice requires a secure connection:** reopen the web app over HTTPS or localhost, or use the
  desktop app.
- **Environment offline, stale, or changed:** reconnect it, list the target again, and retry the
  action.
- **Rate limited, timed out, or upstream failure:** wait briefly, then start a new session.
