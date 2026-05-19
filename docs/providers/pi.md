# Pi

This guide is for people who want to use Pi Agent from T3 Code.

Pi does not currently ship a native ACP command. T3 Code runs Pi through the
[`pi-acp`](https://github.com/svkozak/pi-acp) adapter, which speaks ACP over stdio and starts
`pi --mode rpc --no-themes` behind the scenes.

## Install Pi

Install Pi Agent and the ACP adapter:

```bash
npm install -g @earendil-works/pi-coding-agent pi-acp
```

Verify both commands:

```bash
pi --version
pi-acp --help
```

Then run Pi once in a terminal and configure the model provider/API key you want Pi to use.

For GPT-5.5 parity with the Hermes setup, Pi needs its own ChatGPT Plus/Pro Codex login. Start
Pi, run `/login`, choose the ChatGPT Plus/Pro Codex provider, and complete the browser sign-in.
Pi stores this under `~/.pi/agent/auth.json`; T3 Code does not reuse Hermes credentials.

After login, Pi should have these defaults in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.5"
}
```

## Configure T3 Code

In Settings, enable Pi and set:

```text
ACP adapter path: pi-acp
Pi binary path: pi
```

Absolute paths are recommended for packaged macOS builds because GUI apps can have a smaller
`PATH` than your terminal. Common paths are:

```text
/opt/homebrew/bin/pi-acp
/opt/homebrew/bin/pi
/usr/local/bin/pi-acp
/usr/local/bin/pi
/Users/you/.local/bin/pi-acp
/Users/you/.local/bin/pi
```

On Windows, global npm installs usually create `.cmd` shims under the roaming npm directory. Common
paths are:

```text
C:\Users\you\AppData\Roaming\npm\pi-acp.cmd
C:\Users\you\AppData\Roaming\npm\pi.cmd
```

T3 Code passes the configured Pi binary to `pi-acp` through `PI_ACP_PI_COMMAND`, so the adapter can
find Pi even when the app is launched outside your shell.

The Pi provider card also includes a provider update action. Use it after Pi reports a newer
version, or run the same update manually from a terminal:

```bash
pi update
```

## Test a Chat

In T3 Code, select Pi in the model picker and send a small prompt. Pi manages authentication and
model provider setup through its own CLI and config; T3 Code only starts `pi-acp` when a Pi
conversation needs it.

For GPT-5.5, verify Pi can see the Codex model after login:

```bash
pi --provider openai-codex --list-models gpt
```

If Settings says Pi is unavailable, verify both commands from the same environment:

```bash
pi --version
pi-acp --help
```

If Pi is installed but the adapter is missing, run:

```bash
npm install -g pi-acp
```

If the adapter is installed but cannot find Pi, set the Pi binary path to an absolute path such as
`/opt/homebrew/bin/pi`.
