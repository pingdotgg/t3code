# Hermes Agent

Hermes support is available as an Early Access provider. T3 Code connects to the official Hermes
Agent Protocol server and uses Hermes' existing models, credentials, tools, skills, rules, and
session history.

## Set up Hermes

Install Hermes Agent using the instructions at
[hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com), then configure a model:

```sh
hermes setup --quick
```

Restart or refresh T3 Code's provider status after setup. The Hermes card reports the detected CLI
version and offers the normal provider update action, which runs `hermes update`. Hermes Agent
0.20.0 or newer is required for the supported ACP behavior.

## Multiple Hermes instances

The built-in instance uses Hermes' normal home directory. Additional provider instances can set a
different **HERMES_HOME path** or supply `HERMES_HOME` in their environment. Instances that use the
same Hermes home can continue each other's sessions; different homes keep configuration,
credentials, and history isolated.

Hermes reports its configured models directly to T3 Code. Custom entries must use the exact model
identifier expected by Hermes, normally `provider:model`. The `default` entry keeps the model
selected in Hermes.

## Permissions and active turns

T3 Code maps permission modes as follows:

| T3 Code mode      | Hermes mode    |
| ----------------- | -------------- |
| Approval required | `default`      |
| Auto              | `default`      |
| Auto-accept edits | `accept_edits` |
| Full access       | `dont_ask`     |

Approval buttons use the choices returned by Hermes. Automatic approval prefers the session-scoped
choice and never silently creates a permanent grant.

Plain-text messages sent while Hermes is working redirect the active turn. Images are sent through
Hermes' ACP image support. Hermes slash commands advertised by the running CLI appear in the
composer. Interactive sessions load both Hermes' configured MCP servers and T3 Code's bridge;
short-lived provider checks and source-control text generation skip configured MCP startup.

T3 Code persists Hermes' ACP session ID for continuation. On resume, Hermes restores its own
history while T3 Code suppresses that replay because the conversation is already stored in the
thread.

Hermes manages skill discovery itself. T3 Code does not duplicate Hermes skills in its own skill
picker, and Hermes ACP does not currently expose T3 Code's separate Plan interaction toggle or
structured question forms.
