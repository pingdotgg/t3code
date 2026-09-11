# MCP gateway processes and port ownership

Each stdio MCP connection starts a gateway launcher. Hosts that open several sessions can
therefore create several launcher processes. The launchers share one detached gateway owner
per loopback bridge address (default `127.0.0.1:47631`). Only that owner opens the durable
SQLite store, ingests runtime events, and runs webhook delivery.

The desktop connects to the owner's existing runtime bridge. Each launcher uses a separate,
mutually authenticated MCP connection on `/mcp` at the same address. MCP connections cannot
replace the desktop connection or change its grants. Tool requests, responses and notification
subscriptions stay separate between sessions; durable receipts and events are shared.

When no owner is listening, a launcher starts one and waits for its startup receipt. If several
launchers race, only the process that binds the port initializes the store and delivery worker.
The others attach to the winner. An owner remains alive while any MCP session uses it, even if
the launcher that started it exits. It shuts down after 30 seconds with no MCP sessions,
finishing any in-flight webhook delivery before closing the store.

All launchers sharing an address must use the same bridge token, state file, retention setting,
repository allowlist and initial grants. A different configuration, wrong token, unrelated
listener or older gateway causes an explicit connection error. A launcher does not claim to
provide a working MCP session when its bridge is unavailable. Independent gateways must use
distinct bridge ports and state files.

If the owner stops, attached MCP sessions disconnect. Reconnect through the MCP host to start
or attach to an owner again. The desktop uses its existing bridge reconnect behavior. The
launcher does not automatically replay in-flight mutations; use the same idempotency key to
recover their durable receipts.

## Upgrade from a gateway that binds once per MCP session

1. Pull the branch containing shared gateway support. For a source launch, keep the existing
   `node.exe packages/mcp-gateway/src/bin.ts` command and environment configuration. For a
   packaged launch, rebuild and install the desktop artifact so its bundled gateway is updated.
2. Disconnect the old MCP integration in the host so it stops starting old gateway processes.
3. Identify the process listening on the configured bridge port and inspect its executable and
   parent. Stop only confirmed obsolete gateway processes. Do not kill the Codex host or all
   Node processes by name. Previously observed PIDs may have been reused.
4. Reconnect the integration. Open several sessions and call `t3_get_gateway_health` and
   `t3_list_environments` from each. All should reach the same connected runtime and see the
   environments permitted by the saved grants. Closing one session must leave others usable.

On Windows, these read-only commands identify the listener and its parent without printing
command lines that might contain credentials:

```powershell
$gatewayListeners = Get-NetTCPConnection -LocalPort 47631 -State Listen
$gatewayListeners | Select-Object LocalAddress, LocalPort, OwningProcess
foreach ($gatewayListener in $gatewayListeners) {
    Get-CimInstance Win32_Process -Filter "ProcessId = $($gatewayListener.OwningProcess)" |
        Select-Object ProcessId, ParentProcessId, ExecutablePath
}
```

Several launcher processes plus one owner are expected. Only the owner should listen on the
bridge port. A healthy result is a connected bridge and usable environments from every MCP
session, not a particular total process count.

A launch through `node.exe` does not require `ELECTRON_RUN_AS_NODE`. A packaged launch through
the desktop executable still requires `ELECTRON_RUN_AS_NODE=1`, as provided by its launch config.
