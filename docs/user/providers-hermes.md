# Hermes Agent

T3 Code connects to Hermes through its Agent Client Protocol (ACP) server and can import existing
Hermes session history.

## Set Up Hermes

Install Hermes and complete its provider setup first:

```bash
hermes setup
hermes --version
```

Open T3 Code Settings, select **Providers**, and enable Hermes. The default binary is `hermes`. If
it is not on the server's `PATH`, set **Binary path** to the full Hermes executable path.

Leave **ACP auth method** blank in normal setups. T3 Code uses the authentication method Hermes
advertises during the ACP handshake. Set it explicitly only for a custom Hermes configuration.

## Import All Existing Chats

In **Settings → Providers**, find **Hermes chat history** and select **Import all chats**.

The import:

- reads every session from `hermes sessions export - --yes`
- creates T3 Code projects based on each session's repository root or working directory
- preserves user and assistant messages, titles, and timestamps
- links the imported thread to its original Hermes session so it can be continued
- safely skips chats that were already imported or contain no visible conversation

Run the import again whenever you want to bring in newer Hermes chats. Existing imported sessions
are not duplicated.

For a non-default profile, set **HERMES_HOME path** on the Hermes provider before importing. The
same provider instance and home are used for both chat sessions and history import.

## Updates

When provider update checks are enabled, T3 Code compares the installed Hermes version with the
latest stable Hermes GitHub release. An available release appears on the Hermes provider row in
**Settings → Providers**.

Select **Update now** to run Hermes's supported non-interactive updater on the server machine. You
can also copy and run the displayed `hermes update --yes` command yourself. If the provider uses a
custom **Binary path**, T3 Code runs that binary for the update.

## Troubleshooting

- **Hermes is unavailable:** verify the configured binary runs with `hermes --version` on the T3
  Code server machine.
- **Import fails:** run `hermes sessions export - --yes` directly and check that it completes.
- **A new chat times out during startup:** run `hermes acp` or a normal `hermes` chat directly.
  Hermes may be waiting on one of its configured plugins or MCP servers during session creation.
