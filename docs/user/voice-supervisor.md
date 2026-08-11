# Voice Supervisor

Voice Supervisor lets you talk to T3 Code about work across the environments known to your current
client. It uses OpenAI Realtime for the voice conversation, but the work it supervises is
provider-neutral: the same session can inspect T3 threads running Codex, Claude, Cursor, Grok, or
OpenCode and propose actions for eligible live threads.

Voice Supervisor is available in the web, desktop, and mobile apps.

## Set Up Voice

To store a key, open **Settings** → **Voice** in the web or desktop app, choose the environment
that should host the voice credential, enter an OpenAI API key, and choose **Save key**. The mobile
app can use a configured voice host but cannot set or remove its stored key. Configure the same
environment from web or desktop, or set `OPENAI_API_KEY` in the host environment's process.

On any client:

1. Open Voice Supervisor.
2. Choose a host environment and voice.
3. Choose **Start voice** on web or desktop, or **Start** on mobile.
4. Allow microphone access when your browser or operating system asks.

The settings page never requests microphone access, mints a client secret, or starts a session.
Only the explicit Start action does that.

The selected host environment must be connected, up to date, and advertise Realtime voice
support. It supplies the short-lived session credential, but it does not limit which environments
known to the current client the supervisor can discuss.

A stored key takes precedence over `OPENAI_API_KEY`. Removing it from web or desktop makes the
environment fall back to `OPENAI_API_KEY`, if present. The long-lived key is write-only from the
client: T3 reports whether one is configured and where it came from, but never returns its value.

Managing a stored key requires `access:write` permission. If a remote session does not have that
permission, reconnect with an appropriate link or configure `OPENAI_API_KEY` on the environment
host.

## Open Voice Supervisor

Voice Supervisor is global, so it stays available as you move between projects and threads. Open
or hide its web and desktop panel from any of these entry points:

- the floating microphone launcher in the lower-right corner;
- **Voice** in the main sidebar or Settings sidebar;
- **Toggle voice supervisor** in the Command Palette;
- a custom shortcut assigned to `voice.toggle` under **Settings** → **Keybindings**.

There is no default shortcut for `voice.toggle`.

On mobile, open **Settings** → **Voice Supervisor** or use the `t3code://voice` deep link. There is
no idle floating microphone launcher on mobile. After a session starts, fails, or needs a local
confirmation while its screen is hidden, a compact control appears over other routes. It shows the
connecting, listening, muted, failed, or pending-confirmation state and reopens Voice Supervisor.

Choose the host environment and voice before starting. Those selectors stay locked while a
session is connecting or active. Marin is the default voice; Alloy, Ash, Ballad, Coral, Echo,
Sage, Shimmer, Verse, and Cedar are also available.

## Session Controls

- **Mute** stops sending microphone audio without ending the session or releasing microphone
  capture. **Unmute** resumes sending it.
- **Stop** ends the session and releases its microphone capture, audio, and network resources.
- On web and desktop, **Hide** closes only the panel. On mobile, Back or navigating away closes only
  the screen. Neither action stops or mutes an active session. Use **Mute** before hiding if you do
  not want to send microphone audio, or **Stop** to release capture and end the session.

The web launcher and mobile compact control indicate connecting, listening, muted, failed, and
pending-confirmation states. T3 also mutes the microphone automatically while tool work or a local
confirmation is in progress, then restores the mute state you chose.

Mobile voice sessions are foreground-only. If the mobile app becomes inactive or moves to the
background, or its native audio session is interrupted, T3 ends the voice session and releases its
resources. It does not resume or reconnect automatically; return to the app and choose **Start**
again. The initial iOS microphone permission prompt is handled separately so that prompt alone does
not end startup.

The panel or mobile screen shows a bounded recent transcript and activity feed. Starting a new
voice session resets that history; it is not a durable coding thread. Your spoken transcript is
produced by a separate input-transcription stream (`gpt-4o-mini-transcribe`) from the Realtime
conversation model (`gpt-realtime-2.1`). It is a useful display transcript, not a record of the
model's exact internal interpretation, and transcription can fail independently of the voice
conversation.

## What the Supervisor Can Do

The supervisor has exactly eight tools:

| Tool                 | What it does                                                               | Local confirmation |
| -------------------- | -------------------------------------------------------------------------- | ------------------ |
| `list_active_work`   | Lists known threads that still have active or actionable work              | No                 |
| `list_projects`      | Lists projects across the current client's known environments              | No                 |
| `list_threads`       | Lists non-archived threads across the current client's known environments  | No                 |
| `get_thread_summary` | Reads a bounded status summary and current plan step                       | No                 |
| `open_thread`        | Opens the exact thread in your current client                              | No                 |
| `start_thread`       | Prepares a new thread with resolved T3 model, mode, and workspace defaults | Yes                |
| `send_follow_up`     | Prepares an instruction for an existing thread                             | Yes                |
| `interrupt_thread`   | Prepares an interrupt for a thread's active turn                           | Yes                |

Voice Supervisor has no direct file, terminal, approval, user-input, delete, archive, or restore
tools, and it cannot return full thread histories. A locally confirmed `start_thread` or
`send_follow_up` sends the prepared instruction to the target coding agent, which retains its
normal tools and configured permission mode. Any later provider approval or user-input prompt
remains separate and cannot be handled by Voice Supervisor.

On mobile, a voice-created thread uses durable defaults from the target project and environment,
including a usable saved project model or the environment's configured fallback, and its project →
`t3.json` → environment workspace setting. It does not copy an unfinished mobile New Task draft or
infer defaults from the currently open screen. The confirmation card shows the exact resolved
model, modes, and workspace before anything runs.

## Confirming Changes

Starting a thread, sending a follow-up, and interrupting a thread never execute from the model's
tool call alone. T3 shows a local confirmation card with the exact target and action. Start-thread
cards also show the title, complete instruction, model, permission and interaction modes,
workspace choice, base branch when applicable, and whether the setup script will run.

Choose **Confirm** to execute or **Deny** to cancel. On web and desktop, Enter confirms when the
confirmation card itself has focus, and Escape denies when focus is anywhere in the card. Elsewhere
in the web panel, Escape only hides the panel and the pending proposal remains. On mobile, use the
card's **Confirm** or **Deny** button. Pressing Back or navigating away hides the screen and leaves a
pending proposal for the compact control to surface. Saying “yes” to the voice model is not a local
confirmation.

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
and speaker belong to the client device where you choose **Start voice** on web or desktop, or
**Start** on mobile; the selected environment host does not need a microphone.

The client requests a short-lived credential through the selected environment using the same
authenticated connection as other T3 operations. It then sends microphone audio and receives
response audio directly over WebRTC. The T3 environment and T3 Connect do not proxy those audio
streams. Tool reads use the current client's environment catalog, while confirmed commands route
to the exact live environment that owns the project or thread. `open_thread` navigation stays local
to the current client. Compact tool results return to OpenAI over the Realtime data channel.

For Voice Supervisor in a browser, the page must be a secure context, normally HTTPS or localhost,
because browser microphone capture requires it. A plain HTTP page opened from another device may
support ordinary T3 controls, but Voice Supervisor cannot capture the microphone there. Prefer the
desktop or mobile app, `https://app.t3.codes`, or another trusted HTTPS endpoint.

## Cost, Data Flow, and Privacy

OpenAI bills Realtime API usage to the account behind the configured API key. This usage is
separate from ChatGPT, Codex, and other provider subscriptions, and T3 does not enforce a spending
budget for the session.

When you start voice:

1. The selected T3 environment uses the long-lived API key only to request a short-lived OpenAI
   client secret. That request sends OpenAI a stable, hashed pseudonymous identifier derived from
   the environment ID for safety tracking.
2. The browser, desktop app, or mobile app uses that secret to connect directly to OpenAI, sends
   microphone audio, and receives response audio directly over WebRTC.
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
- Each client instance—each browser tab, desktop app window, or mobile app instance—owns at most
  one active voice session. Multiple clients can each run their own session. Within one session,
  only one tool-response batch is active at a time. A mutating proposal may wait for one local
  confirmation; identical response replays are ignored, while overlapping work, reused tool-call
  IDs, or conflicting replays fail closed.
- Target handles normally expire after about two minutes and confirmation proposals after about
  30 seconds. Ask the supervisor to list the work again if a target or confirmation expires.
- Startup negotiation and configuration time out instead of hanging. The microphone permission
  prompt itself has no T3 timeout, so you can respond to the browser or operating-system dialog.
- Voice does not automatically reconnect after a failed or closed session. Correct the displayed
  problem and choose **Start voice** on web or desktop, or **Start** on mobile, again.

Common failures:

- **Voice is unsupported:** update the selected environment's T3 server. Older servers do not
  advertise the required capability.
- **No key, rejected key, or model unavailable:** check the selected environment under
  **Settings** → **Voice** in web or desktop, or verify `OPENAI_API_KEY` on the environment host,
  and confirm that the API account can use OpenAI Realtime.
- **Microphone unavailable or blocked:** allow microphone access for T3 Code or the browser in
  system settings, then retry.
- **Voice requires a secure connection:** reopen the web app over HTTPS or localhost, or use the
  desktop app.
- **Environment offline, stale, or changed:** reconnect it, list the target again, and retry the
  action.
- **Rate limited, timed out, or upstream failure:** wait briefly, then start a new session.
