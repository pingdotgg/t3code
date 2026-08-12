# Kimi

Kimi support is available as an Early Access provider through the official Kimi Code CLI and its
ACP transport. The Kimi process runs on the machine hosting your T3 Code server, including when you
control it from another browser or the mobile app.

## Install and log in

Install the official CLI:

```bash
npm install -g @moonshot-ai/kimi-code
kimi login
```

T3 Code requires Kimi CLI 0.29.0 or newer. Earlier versions collapse selectable thinking effort
levels into a single `Thinking On` value over ACP. Update Kimi from provider settings or run the
install command again to expose the levels supported by each model.

Confirm that the same shell which starts T3 Code can run `kimi --version`. Then open
**Settings**, select **Kimi**, and enable the provider. If the executable is not on the server's
`PATH`, set **Binary path** to its full path.

T3 Code starts Kimi through `kimi acp`. Models, thinking controls, modes, and slash commands are
read from the CLI at runtime, so the available choices follow the installed Kimi version and your
account rather than a catalog built into T3 Code.

## Separate accounts and configuration

Add multiple Kimi provider instances when you need separate accounts or configurations. Set a
different **KIMI_CODE_HOME path** on each instance; T3 Code uses that directory for the instance's
Kimi credentials, configuration, sessions, and user skills. Environment variables configured on a
provider instance are applied only to that instance's server-side Kimi process.

## Sessions, permissions, and remote use

Kimi sessions can be continued using the session capabilities advertised by the installed CLI.
T3 Code maps Kimi's ACP permission requests into the same approval controls used by other
providers. Plan and other interaction modes appear only when Kimi advertises them.

When T3 Code is hosted remotely, install and authenticate Kimi on the server—not on the phone,
tablet, or browser connecting to it. Attachments and project paths are resolved on that server.

## Early Access limitations

Kimi support follows the capabilities exposed by the CLI's ACP implementation. Unsupported input
types, session operations, or provider-side rollback remain unavailable until Kimi advertises them.
T3 Code does not fabricate missing models, modes, configuration values, or protocol features.
