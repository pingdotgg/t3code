# Devices

The environment server owns simulators and emulators the way it owns
terminals: discovery, streaming, and agent access all run there, and every
client reaches them through the environment connection. This is what makes the
Device panel work over Tailscale and T3 Connect, and what will let a device
host on another machine slot in later.

## Two external tools, one seam

[expo-device-hub](../../apps/server/src/device/LocalDeviceHost.ts) streams and
[agent-device](../../apps/server/src/device/AgentDeviceShim.ts) drives. Both
are npm-installed at pinned versions into the T3 home on first use and run with
the server's Node; `npx` would make the first `device_open` after a reboot
depend on the registry. The hub is a supervised child rather than an imported
middleware because serve-sim loads private CoreSimulator frameworks through a
native addon, and a crash there must not take the server down.

Everything platform-specific sits behind
[`DeviceHost`](../../apps/server/src/device/DeviceHost.ts). The service, the
proxy, and the MCP tools only see a hub origin and an agent-device endpoint.
An SSH or cloud host would forward those two things to the server and change
nothing above it.

## The hub is never exposed

serve-sim has a shell-exec route whose token is readable from its own
unauthenticated `/api`, and serve-emu's action routes have no auth at all. The
hub binds loopback and the only way in is the
[proxy](../../apps/server/src/device/DeviceHubProxy.ts), which allowlists the
stream, config, and screenshot routes and authenticates every request as an
environment session. `<img>` and `WebSocket` cannot carry headers, so the proxy
authenticates like the `/ws` upgrade: cookie, or a short-lived `wsTicket` that
bearer and DPoP clients mint over authenticated HTTP. The ticket is stripped
before the request reaches the hub.

Stream responses carry `Cache-Control: no-transform`; the compression
middleware would otherwise buffer an MJPEG body that never ends. In browser dev,
the Vite proxy must forward WebSocket upgrades for `/api`, not only `/ws`.

## Agents drive through the CLI

The `device_*` toolkit is deliberately four tools: list, open, screenshot, and
close. Driving happens through the `agent-device` CLI, which has the semantic
snapshot model agents need and stays current with its own releases. T3 prepends
a shim directory to the provider's PATH and sets
`AGENT_DEVICE_DAEMON_BASE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN` so the
agent never handles the endpoint or token.

That environment is fixed when the provider subprocess spawns, so
[`prepareMcpSession`](../../apps/server/src/provider/Layers/ProviderService.ts)
starts the device host whenever the session has the `device` capability and
the machine can run at least one platform. Starting it later from
`device_open` would leave the already-running agent without the CLI.

How to drive a device is returned from `device_open`, not kept in an
always-loaded prompt or skill: it costs nothing in threads that never open a
device and cannot drift from the pinned CLI version. The always-on prompt block
is a few lines that point at the tools and forbid raw `simctl` and `adb`.

## The viewer decodes both vendored protocols

The hub vendors two streaming servers with different wire formats. iOS video is
an HTTP body of AVCC envelopes decoded with WebCodecs, with input on a separate
binary WebSocket; Android multiplexes SEMU-framed H.264 and JSON gestures over
one WebSocket. [`deviceStream.ts`](../../apps/web/src/components/device/deviceStream.ts)
speaks both so one panel covers both platforms.

Simulators encode H.264 High 5.1. Hardware decoders on some machines and all
headless browsers reject that profile, and WebCodecs is secure-context only, so
the viewer probes `isConfigSupported` and falls back to the MJPEG endpoint on
iOS. Android has no MJPEG; there the panel reports that it cannot decode.
