# Hermes T3 Code Gateway

Experimental Hermes platform plugin for connecting one already-running Hermes
process to T3 Code. The plugin makes an outbound WebSocket connection; Hermes
does not need to listen on a public port.

The gateway wire protocol is v5. The T3 server and Hermes plugin must be updated
together; mismatched versions fail the connection handshake closed.

Each T3 thread maps deterministically to one Hermes gateway session. A new T3
thread creates a new session identity, later messages use the same identity,
active-turn messages use Hermes' native `/steer` path, and stopping a turn does
not delete its transcript.

## Install from this repository

Run the install script. It symlinks this directory into the active Hermes
profile's user-plugin directory and enables the plugin:

```bash
./integrations/hermes-t3-gateway/install.sh
```

The script is safe to re-run: an existing correct symlink is left in place, and
enabling an already-enabled plugin is a no-op. It installs into
`$HERMES_HOME/plugins/` when `HERMES_HOME` is set, and `~/.hermes/plugins/`
otherwise. It fails with instructions if `hermes` is not on `PATH`, and refuses
to replace a real directory already sitting at the target path.

In T3 Code, open the Hermes instance settings, choose **Add Hermes**, enter a
unique nickname, and copy the generated enrollment command. It has this shape:

```bash
hermes t3 connect \
  --url https://siva.davis7.space:<port> \
  --token <one-time-token>
```

`--url` accepts an HTTP(S) browser origin or an explicit WS(S) URL. The command
normalizes it to `/api/hermes-gateway/ws`, enrolls over the first authenticated
`connection.hello` frame, and saves these values with Hermes'
profile-aware `save_env_value` helper:

- `HERMES_T3_GATEWAY_URL`
- `HERMES_T3_GATEWAY_INSTANCE_ID`
- `HERMES_T3_GATEWAY_CREDENTIAL`
- `HERMES_T3_GATEWAY_NICKNAME`

The long-lived credential is never printed. Run `hermes gateway restart` after
enrollment. `hermes t3 status` reports the local enrollment without revealing
the credential.

T3 loads the selectable model catalog on demand from Hermes' explicitly
configured providers. Changing model or reasoning in T3 applies Hermes'
official `/model ... --session` and `/reasoning ...` commands before the next
turn starts. These are per-session overrides: they never rewrite Hermes'
global `config.yaml`, and each T3 thread remains isolated from the others.

## The Home thread

Every enrolled instance gets one **Home** thread in T3, created automatically —
there is nothing to set up and nothing to choose. It receives all of Hermes'
proactive output: cron results (`deliver=t3`), the agent's `send_message` tool
with a bare `t3` target, gateway online/shutdown notices, and `/handoff t3`.
Replying in it runs an ordinary Hermes turn in the same thread.

**T3 owns the designation, and `T3_HOME_CHANNEL` is a synced cache of it.** The
plugin writes that variable itself: T3 republishes the home thread id on every
successful handshake, and the plugin compares and persists it with Hermes'
profile-aware `save_env_value` helper. A hand-edited `T3_HOME_CHANNEL` will
therefore be **overwritten on the next reconnect** — to move the Home thread,
change it in T3, not in `.env`. (`/sethome` is likewise inert for this platform:
the designation is fixed, so Hermes' "set a home channel" nudge is suppressed.)

Deliveries are durable in both directions. Each one is written to a small JSONL
queue at `<hermes home>/gateway/t3_home_delivery_queue.jsonl` before it is sent
and removed only once T3 acknowledges it, so nothing is lost if either side
restarts mid-flight; queued deliveries flush on the next connect, and T3
deduplicates so a replay is harmless. The queue is capped and drops oldest-first
with a logged warning rather than growing without bound.

Cron works whether or not the gateway is co-resident. When `hermes cron` runs in
its own process there is no live adapter, so the plugin dials T3 over a
short-lived delivery connection — authenticated the same way, but never
registered as the instance's primary connection, so it cannot disturb a running
`hermes gateway`. If T3 is unreachable the delivery is queued and the cron job
still reports success.

Attachments ride the same queue-then-ack durability as text: one `media.deliver`
frame per file, each carrying the file's bytes rather than its path, so a
delivery that flushes after an outage still works when the original temp file is
long gone. The raw ceiling is 25MiB per file. A file that cannot be read or that
exceeds the ceiling is reported in the result's `detail` and skipped rather than
queued — a frame T3 would reject forever must not sit in the outbox forever.
Every send result also reports `media_count`, `acked_count`, and `delivery_ids`.

## Initial scope

- Text input and live assistant streaming
- Authoritative text replacement when Hermes revises cumulative streamed output
- Multiple concurrent Hermes sessions in one process
- On-demand model catalog plus per-session model and reasoning selection
- Active-turn steering and interrupt
- Dangerous-command approvals
- Structured `clarify` questions
- Tool lifecycle activity through Hermes plugin hooks
- Reconnect with bounded backoff
- Version-incompatible and revoked credentials fail closed

- Proactive delivery into the Home thread: cron, `send_message`, lifecycle
  notices, `/handoff` — with a durable queue and out-of-process cron support
- Inbound attachments: files sent from T3 ride `turn.start` / `turn.steer` and
  reach Hermes as ordinary media on the message event
- Outbound attachments: `MEDIA:` files from cron, `send_message`, and `/handoff`
  are delivered as `media.deliver` frames

Non-home T3 threads remain session-only: Hermes cannot message them unprompted,
and an unsolicited send to one still fails with `no active T3 turn`.

Attachments are pinned to `true`. It has been part of the contract since v4
rather than a negotiated option — T3's schema fixes the capability at that
literal, so a plugin that cannot handle attachments is by definition a v3
plugin and is rejected at the version gate. Inbound files arrive on
`turn.start` / `turn.steer` and are
materialized to private temp files before the turn starts; outbound files leave
as `media.deliver` frames.

## Upstream core bugs this plugin works around

Hermes core decides media support for `send_message` from a hard-coded list of
platform names rather than from a platform capability, so a plugin platform that
delivers media perfectly well is still treated as if it cannot. Two consequences,
both against **v0.19.0**:

- **A false warning.** `tools/send_message_tool.py:1108` builds `"MEDIA
attachments were omitted for t3; ..."` whenever a send carries files and the
  platform is off that list, and line 1154 appends it to _any_ successful result
  without checking whether anything was actually dropped. Left alone, the tool
  output tells the agent the files were lost immediately after T3 acknowledged
  them — which is exactly how a live agent came to report a delivery failure for
  files the user could already see.
- **A silent drop.** `tools/send_message_tool.py:711`, taken when the gateway is
  co-resident with the caller, invokes `adapter.send(chat_id, content, metadata)`
  and returns. `media_files` is never passed, and the `MEDIA:` directives were
  already stripped out of `content` upstream at line 442, so the attachments are
  simply gone — no error, no warning. Out-of-process sends escape this only
  because they fall through to the plugin's standalone sender instead.

`coreshim.py` compensates for both in-process at plugin load: co-resident `t3`
sends carrying media are rerouted through the plugin's own sender, media-only
sends are rescued from the related hard error at line 1101, and the false warning
is stripped by stable prefix. Everything else — every other platform, every
text-only send — reaches the original untouched.

**Residual caveat.** The shim is deliberately fail-open: it feature-detects each
target function and, on any signature or shape mismatch, logs one warning and
leaves core alone rather than risking a crash on an upstream upgrade. When that
happens the two bugs return as described above. The accounting keys on every
send result (`media_count`, `acked_count`, and a note naming the delivered file
count) are the backstop — they sit in the same JSON as any stale warning and
contradict it directly. Grep the logs for `leaving it unpatched` to detect it.
The whole module is removable once upstream drives media handling from platform
capabilities instead of the hard-coded list.

See [COMPATIBILITY.md](./COMPATIBILITY.md) for public Hermes extension-surface
limitations.

## Tests

The pure protocol and transport tests do not require a live Hermes or T3 server:

```bash
python -m unittest discover \
  integrations/hermes-t3-gateway/tests \
  -p 'test_*.py'
```
