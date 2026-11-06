# ZeroClaw

T3 Code connects to a running ZeroClaw daemon on the environment's server machine.
The daemon owns the agents, model credentials, and tool permissions.

## Set up ZeroClaw

1. Install and configure ZeroClaw 0.8.7 or newer on the machine running the T3 Code server.
2. Start the daemon with `zeroclaw daemon`.
3. Open **Settings → Providers** in T3 Code and enable **ZeroClaw** for that environment.
4. If the daemon uses a custom socket, set **Daemon socket** to its path.
5. Set **Default agent** to the alias you want new threads to use, then refresh the provider.

An empty socket setting uses `ZEROCLAW_SOCKET`, then `~/.zeroclaw/data/daemon.sock`.
With `ZEROCLAW_CONFIG_DIR`, the fallback is `<config-dir>/data/daemon.sock`. For other custom
install layouts or Windows named pipes, set the socket explicitly.
The socket path belongs to the server machine, even when you connect from a phone or remote browser.
Enabling ZeroClaw in T3 Code does not start or stop the daemon.

## Choose an agent and model

Choose an agent when you start a thread. To use another agent, start a new thread.
ZeroClaw cannot change the agent of an existing session.

The model picker lists models from the daemon's catalog. **Agent default** uses the agent's
configured model. You can switch to a named model during a thread, but switching back to
**Agent default** requires a new thread because ZeroClaw cannot clear an active model override.

## Tool approvals and subagents

ZeroClaw's autonomy configuration decides which tools need approval. T3 Code displays the daemon's
approval requests in Supervised mode. That mode does not override the daemon's permission policy
or guarantee that every tool asks for approval. Pending approvals do not survive a disconnected session.

Foreground `spawn_subagent` and `delegate` calls appear as subagent cards. Background delegates
appear as tool calls because T3 Code cannot track their completion.

## Troubleshooting

If the provider is unavailable, confirm that the daemon is running on the server machine and
that the T3 Code server can access its socket. Check **Daemon socket** and `ZEROCLAW_SOCKET`,
then refresh the provider in Settings.

If a thread asks you to choose an agent, set **Default agent** in provider settings or choose an
agent for the new thread. An agent alias must match one configured in the daemon.
