# conn-devices

Device hosts for the Device panel and the device tools: iOS Simulators and Android Emulators
on this machine, or on a Mac over SSH. The T3 server's `apps/server/src/device` is the
reference. A Conn Server in a Linux container reaches simulators only on an SSH host, so that
is the main path.

| Path | Holds |
| --- | --- |
| `src/service.rs` | `Devices`: the hosts, the published `DeviceServiceState`, `device.*` |
| `src/ssh.rs` | An SSH host: T3's Node bootstrap, `ssh -L` for the hub and daemon, reconnects |
| `src/local.rs` | This machine: npm installs under `<home>/tools`, the hub and daemon as children |
| `src/hub.rs` | expo-device-hub: list, boot, attach, shutdown, screenshot |
| `src/actions.rs` | Device settings: simctl, serve-sim's helper, adb |
| `src/agent.rs` | agent-device sessions, config files, launchers |
| `src/tool_api.rs` | `device_list`, `device_open`, `device_screenshot`, `device_close` |
| `src/proxy.rs` | The hub proxy's allow-lists and the MJPEG still-frame repeat |
| `src/generated.rs` | Generated from `apps/server` by `tools/gen-devices.mjs` |

The server side: `conn-server/src/methods/devices.rs` (the methods) and
`conn-server/src/routes/device_hub.rs` (`/api/device-hub/*`); `conn-mcp/src/tools/devices.rs`.

## How a device opens

1. `device.list` (or a tool) makes the host ready. For an SSH host: `ssh … sh -c '<PATH setup>
   … exec node'` with T3's bootstrap script on stdin, in mode `probe`, then `start` (or
   `agent-start` for agents). The script installs the pinned expo-device-hub (and agent-device)
   in `~/.t3/device/tools` on the Mac and starts them for this server's owner folder.
2. One `ssh -L` forwards the hub (and the daemon) to loopback ports here. ssh's stdin stays
   open: when the server goes, the remote `cat` ends and the forward with it. Three missed
   health probes in a row, or an ssh exit, reconnect with a backoff of 1 to 30 s.
3. `device.open` boots or attaches through the hub; the Device panel streams through the proxy.
4. `device_open` also writes the daemon's endpoint to `<state>/device/hosts/<hash>.json` and a
   launcher under `<state>/device/targets/<session>/agent-device` with the target flags built
   in. The launcher runs the local agent-device CLI (installed with npm on first use).

## Bounds

One state behind one lock, published through a watch channel (a slow subscriber skips states).
Command output is capped at 64 MiB; JSON answers at 4 MiB; ssh's stderr tail at 2,000 bytes.
The proxy streams with backpressure (a channel of one chunk); for MJPEG it keeps only the last
frame (at most 16 MiB). Launchers follow the sessions; all go at start.

## Drift

`tools/gen-devices.mjs --check` fails when T3's bootstrap script, launcher, tool pins
(`deviceToolVersions.json`), screenshot script or proxy lists change. `tools/conformance.mjs`
runs both servers on stand-in `ssh` and `npm` (`tools/stubs`) and compares every answer and
every command they run; the inline ssh options are held there.

## Not served

Expo and Simlock hosts (cloud and leased devices): the state leaves `supportsEasHosts` and
`supportsSimlockHosts` out, so clients do not offer them, and `device.easAccount` and
`device.simlockIdentity` answer the T3 device service's own typed error for that case.
