# Hermes T3 Code Gateway

Experimental Hermes platform plugin for connecting one already-running Hermes
process to T3 Code. The plugin makes an outbound WebSocket connection; Hermes
does not need to listen on a public port.

Each T3 thread maps deterministically to one Hermes gateway session. A new T3
thread creates a new session identity, later messages use the same identity,
active-turn messages use Hermes' native `/steer` path, and stopping a turn does
not delete its transcript.

## Install from this repository

Copy or symlink this directory into the active Hermes profile:

```bash
mkdir -p ~/.hermes/plugins
ln -s /path/to/t3code/integrations/hermes-t3-gateway \
  ~/.hermes/plugins/hermes-t3-gateway
hermes plugins enable hermes-t3-gateway
```

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

The long-lived credential is never printed. Restart `hermes gateway` after
enrollment. `hermes t3 status` reports the local enrollment without revealing
the credential.

## V1 scope

- Text input and live assistant streaming
- Multiple concurrent Hermes sessions in one process
- Active-turn steering and interrupt
- Dangerous-command approvals
- Structured `clarify` questions
- Tool lifecycle activity through Hermes plugin hooks
- Reconnect with bounded backoff
- Version-incompatible and revoked credentials fail closed

Attachments intentionally advertise `false`. Adding bounded image/file input is
the first post-stability feature and should not reuse arbitrary raw payloads.

See [COMPATIBILITY.md](./COMPATIBILITY.md) for public Hermes extension-surface
limitations.

## Tests

The pure protocol and transport tests do not require a live Hermes or T3 server:

```bash
python -m unittest discover \
  integrations/hermes-t3-gateway/tests \
  -p 'test_*.py'
```
