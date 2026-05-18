# Hermes

This guide is for people who want to use Hermes Agent from T3 Code.

Hermes runs as a local CLI process through ACP. T3 Code only starts `hermes acp` when a Hermes
conversation needs it, so provider refreshes stay fast.

## Install Hermes

Install and configure Hermes Agent from the upstream project:

```bash
git clone https://github.com/nousresearch/hermes-agent.git ~/Projects/hermes-agent
cd ~/Projects/hermes-agent
python3 -m venv venv
./venv/bin/pip install -e .
```

Create a stable binary path that GUI apps can find:

```bash
mkdir -p ~/.local/bin
ln -sf ~/Projects/hermes-agent/venv/bin/hermes ~/.local/bin/hermes
~/.local/bin/hermes --version
```

Then run Hermes setup:

```bash
~/.local/bin/hermes model
```

Hermes stores its model configuration in:

```text
~/.hermes/config.yaml
```

T3 Code reads `model.default` from that file and shows it in the model picker. If the config file is
missing or unreadable, T3 Code falls back to `Hermes Default`.

## Configure T3 Code

In Settings, enable Hermes and set:

```text
Binary path: /Users/you/.local/bin/hermes
```

Using the full path is recommended on macOS because apps launched from the Dock or a desktop shell
may not inherit your terminal `PATH`.

## Verify

Run:

```bash
/Users/you/.local/bin/hermes --version
/Users/you/.local/bin/hermes acp
```

The ACP command should stay running and print a startup message. Stop it with `Ctrl-C`.

In T3 Code, select Hermes in the model picker and send a small prompt. If Hermes has a configured
default model, the picker should show that model name rather than only `Hermes Default`.

## Troubleshooting

If T3 Code says Hermes is not installed, use an absolute binary path instead of `hermes`.

If the model picker says no models were found, refresh provider status and confirm that Hermes is
enabled. Disabled, missing, or not-ready providers are not treated as selectable model sources.

If Hermes asks for auth or model setup, run:

```bash
~/.local/bin/hermes model
```
