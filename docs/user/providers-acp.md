# ACP providers

T3 Code can run any coding agent that speaks [ACP](https://agentclientprotocol.com) over stdio.
Native drivers (Codex, Claude, Cursor, Grok, OpenCode) stay first-class. Everything else — Gemini,
GitHub Copilot, Pi, Hermes, Qwen, Kimi, or a custom CLI — is one ACP provider instance with a launch
command.

T3 Code does not download agent binaries. Install the CLI yourself, then point T3 Code at it.

## Add a featured agent

1. Open **Settings** → **Providers**.
2. Select **Add provider instance**.
3. Choose Gemini, GitHub Copilot, Pi Agent, or another ACP agent.
4. Confirm the command and launch arguments, then add the instance.

Featured agents prefill the usual launch spec:

| Agent          | Command   | Arguments                     |
| -------------- | --------- | ----------------------------- |
| Gemini         | `gemini`  | `--acp`                       |
| GitHub Copilot | `copilot` | `--acp`                       |
| Pi Agent       | `pi-acp`  |                               |
| Hermes         | `hermes`  | `acp`                         |
| Qwen Code      | `qwen`    | `--acp --experimental-skills` |
| Kimi CLI       | `kimi`    | `acp`                         |

Install the matching CLI on the machine running T3 Code, then authenticate it the way that CLI
expects. Refresh provider status after install.

## Custom ACP

Choose **Custom ACP** when the agent is not in the featured list. Set:

- **Command** — the binary or launcher that speaks ACP on stdio
- **Launch arguments** — extra args, for example `--acp`
- **Auth method** — leave blank unless the agent requires a specific ACP authenticate method id

You can also use `npx` or `uvx` as the command if that is how you launch the agent.

## Status and models

T3 Code probes the command, then starts a short ACP session to discover models. If the CLI is
missing, the instance shows an error with the install hint. If the CLI is present but model
discovery fails, the instance stays usable and models load when you start a thread.

Git commit and pull-request text generation still uses a native provider. ACP instances do not
generate that text yet.

## Related

- [Install T3 Code](./install.md)
- [Codex](./providers-codex.md)
- [Claude](./providers-claude.md)
