# Runtime modes

T3 Code has a global runtime mode switch in the chat toolbar:

- **Full access** (default): starts sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- **Supervised**: starts sessions with `approvalPolicy: on-request` and `sandboxMode: workspace-write`, then prompts in-app for command/file approvals.

## Remote Control is outside the SDK runtime

The two modes above apply to sessions T3 drives through the `@anthropic-ai/claude-agent-sdk`
(headless SDK). **Remote Control is different:** it launches the real `claude` CLI as an
independent process and does not use the SDK runtime at all. The Full access / Supervised mode
switch does not apply to Remote Control sessions. Those sessions are governed entirely by the
`claude` CLI's own settings and the commands sent from the Claude iOS or web app through
Anthropic's relay.

See the [Remote Control user guide](../user/remote-control.md) for details.
