# Voice and chat control (Workspace MCP)

Workspace MCP lets a compatible external assistant list projects and threads, summarize conversations, start work, and respond to your requests. It is a prototype; availability in ChatGPT Voice depends on platform support. A successful MCP connection does not by itself enable Voice support.

## Connect to an environment

Point your compatible MCP client at `http://127.0.0.1:<port>/mcp/workspace`, using the port of your running T3 server. Local command-line clients can connect over loopback without a token. Requests with a browser Origin header require authentication. Remote clients require an environment bearer token with orchestration access. Do not expose unauthenticated loopback access through a public proxy.

This connection controls only the environment hosting it. To settle a completed task on desktop-pc, connect to desktop-pc’s workspace MCP. A connection to your MacBook cannot change desktop-pc’s threads. The desktop companion gateway is a separate option: it routes by environment and requires a lifecycle grant to settle threads.

Project paths refer to the T3 environment machine, not the device running the assistant.

## Finish and reopen tasks

Ask the assistant to “settle the completed DaVinci task.” Settle moves a thread to Settled while preserving its conversation, artifacts, and files. Asking to “archive this finished task” uses this same history-preserving settle action. Settings → Archived threads is a separate feature.

The assistant must settle only when you ask, never because a task looks done. Repeating the request is safe. Ask to “unsettle that task” to return it to active without starting a turn or sending a message.

A thread cannot settle while its agent is starting or working, while an approval or user-input request is pending, or while a new turn is queued. Wait for the work to finish and resolve pending requests, then retry. A rejected settle changes no history or artifacts. Archived threads must be restored first.

An agent cannot settle itself while producing its own turn. There is no “settle when this turn ends” operation, and a settle request never automatically interrupts work. Use an external assistant after the turn finishes.

## Assistant guidance

Ask for short summaries rather than spoken transcripts or code. The assistant can list providers, create projects, start threads, follow up, interrupt work, and handle approvals. Before accepting an approval, it should explain the risk and wait for your explicit yes.

## Turn it off

Stop the environment server or revoke the remote environment session token. Local loopback access remains available while the server is listening.
