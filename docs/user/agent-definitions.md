# Agent definitions

Define named agents for a project, such as a planner, an implementer, and a
reviewer. A thread's agent can then hand work to one by name, and it runs as its
own thread with the model, instructions, and limits you set. You can also
[chat with one directly](#chat-with-an-agent).

## Define an agent

Add a Markdown file to `.agents/agents/` in the project. The file name, without
`.md`, is the agent's name: lowercase letters, numbers, and hyphens. The text
below the frontmatter is the agent's instructions.

```markdown
---
description: Reviews diffs for correctness bugs
provider: claudeAgent
model: claude-opus-5-5
options:
  effort: high
runtimeMode: approval-required
interactionMode: plan
isolation: worktree
---

Review the change you are given. Report bugs only, each with the file and line.
```

Every field in the frontmatter is optional:

| Field             | Meaning                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `description`     | What the agent is for. The delegating agent reads it to choose.                 |
| `provider`        | The provider instance to run on, as listed in **Settings > Providers**.         |
| `model`           | The model to use. Without `provider`, it applies to the delegating thread's.    |
| `options`         | Model options such as `effort`, as the model picker lists them.                 |
| `runtimeMode`     | `approval-required`, `auto-accept-edits`, `auto`, or `full-access`.             |
| `interactionMode` | `default` or `plan`.                                                            |
| `isolation`       | `shared` (the default) runs in the same checkout. `worktree` gets its own copy. |

An agent that leaves out `provider` and `model` runs on whatever the delegating
thread uses.

## Agents for every project

Put the same kind of file in the `agents` folder of your T3 home (`~/.t3/agents/`
by default) and every project can use it. When a project defines an agent with the
same name, the project's wins.

## Use an agent

Ask the thread's agent to use one, for example "have the reviewer check this
branch". The agent sees the project's definitions and delegates with the agent's
name. Instructions lead the task. The delegating agent can override the provider,
model, options, runtime mode, interaction mode, and isolation one by one; what it
leaves unset keeps the agent's default. Options belong to a model, so choosing a
different provider or model drops the agent's own model and options.

An agent can never run broader than the thread that delegates to it. If the
definition asks for `full-access` and the thread is supervised, the delegation is
refused.

Definitions are read from the delegating thread's checkout and your T3 home each time, so edits
apply to the next delegation. A file that does not parse is skipped. Agents run in
this environment only, not in a linked one.

## Chat with an agent

To talk to an agent directly instead of asking for a delegation, pick it in the
agent menu beside **Attach** in the web or desktop composer. **Default** is the usual chat. Each
thread remembers its pick, and the agent answers in that same thread.

Picking an agent switches the composer to the agent's provider, model, and options,
and you can still change them. Its instructions go to the provider with your next
message, and again whenever the conversation starts over, such as after a
compaction or a provider switch. Your message shows as you typed it. The thread
keeps its own permissions, plan mode, and checkout, so `runtimeMode`,
`interactionMode`, and `isolation` apply only to delegation.

## Your OpenCode agents

OpenCode agents are separate: pick them in the model options or cycle them with
**Composer: Cycle Agent**. See [OpenCode](./providers-opencode.md#agents).
