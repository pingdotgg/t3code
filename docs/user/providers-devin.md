# Devin

T3 Code integrates Devin CLI as a first-party provider over Devin's Agent Client Protocol (ACP).
That gives T3 Code native streaming, tool calls, permissions, planning, cancellation, session resume,
image attachments, model switching, skills, slash commands, and MCP forwarding.

## Prerequisites

Install [Devin CLI](https://docs.devin.ai/cli). You can authenticate up front:

```bash
devin auth login
devin auth status
```

Or just send a message: when Devin reports it is not signed in, T3 Code starts the CLI's
browser sign-in on the machine running the server, waits for it to finish, and then delivers
your message. For remote/headless servers without a browser, run
`devin auth login --force-manual-token-flow` on that machine instead.

T3 Code discovers the model and skill catalogs from the installed CLI. You do not need to copy model
IDs into settings; new Devin models appear after the next provider refresh.

## Provider settings

The default provider runs `devin acp`. Its settings expose:

- a custom Devin binary, config file, or declarative agent config
- Devin's managed sandbox
- workspace-trust enforcement
- ACP `summarizer` or `review` agent types
- global launch arguments inserted before `acp`
- ACP arguments appended after `acp`

Use **Global launch arguments** for additional current or future Devin flags. For example:

```text
--permission-mode smart
```

T3 Code negotiates the active model and permission mode through ACP for each session. The composer
maps approval-required, normal edit, plan, and full-access operation to Devin's advertised `ask`,
`accept-edits`, `plan`, and `bypass` modes.

## In-session behavior

- Devin's reasoning stream and assistant text stream live into the thread.
- Context usage updates after every turn (and after `/compact`), so the context-window indicator
  stays current.
- Devin's `ask_user_question` prompts appear as structured questions; answers flow back through
  ACP form elicitation.
- In plan mode, the finished plan is captured as a proposed plan for review; implementation stays
  a decision for a later turn.

## Multiple instances

You can add more than one Devin provider in Settings. Each instance can use a different binary,
config, agent config, environment, sandbox policy, or launch-argument preset. T3 Code keeps the
instance identity attached to sessions so resume and model routing remain deterministic.

## Troubleshooting

- If Devin is missing, confirm `devin --version` works in the same shell that starts T3 Code.
- If it is unauthenticated, run `devin auth login`, then refresh provider status.
- If model or skill discovery fails, run `devin models list --format json` and
  `devin skills list --json`.
- If startup flags fail, remember that global flags go before `acp`; T3 Code's separate ACP arguments
  field is only for flags accepted by `devin acp`.
