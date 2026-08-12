# Grok Build

This guide is for people who want to use Grok Build in T3 Code. For first-time setup, see
[Install T3 Code](./install.md).

Log in with the Grok CLI on the machine that runs the T3 Code server:

```bash
grok login
```

You can also set `XAI_API_KEY` in the server environment instead of running `grok login`.

In T3 Code Settings, the default Grok provider can stay like this:

```text
Display name: Grok
Binary path: grok
```

Use an explicit binary path when `grok` is not on the `PATH` of the shell that started T3 Code.

## Models and effort

T3 Code reads the live Grok model list from the CLI. Current Grok Build installs advertise
`grok-4.6` and `grok-4.5`. Each model that supports reasoning effort shows a Reasoning control in
the composer. The menu comes from the CLI, so the levels can differ by model.

T3 Code sends the selected effort on the live session. You do not need a new thread to change
model or effort.

## If Grok looks ready but will not start

Run `grok login` again on the server machine. T3 Code reports an unauthenticated Grok install in
Settings when ACP login fails.
