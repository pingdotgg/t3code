# Claude Code → Codex Model Routing

T3 Code can map Claude Code's `haiku` subagent slot to a GPT/Codex model. The main conversation
still runs on the Claude model you selected. Only agents and workflows that choose `model: "haiku"`
use Codex.

## Connect Codex

1. Open **Settings → Model Routing**.
2. Select **Connect Codex**.
3. Open the displayed OpenAI device-login page and enter the code.
4. Choose the Claude Code instance you want to configure.
5. Select the Codex model and enable **Route Haiku to Codex**.
6. Adjust **Model preferences** for the kinds of work you want Claude or Codex to own.
7. Start a new Claude Code thread.

The bridge account is separate from the normal Codex provider in T3 Code. It belongs to the T3
environment that runs Claude Code, so the same setup works from the web, desktop, and remote
clients. Tokens stay on that environment and are not sent to the client.

## What Is Remapped

These Claude Code calls use the configured Codex model after routing is enabled:

```text
Agent(model: "haiku")
Workflow agent with model: "haiku"
```

Do not enter a raw GPT model ID in Claude Code's agent `model` field. Claude Code still expects its
own aliases there; `haiku` is the alias T3 remaps.

An explicit Anthropic Haiku ID such as `claude-haiku-…` is not remapped. This leaves a direct way to
request real Anthropic Haiku when needed.

When routing is enabled, the configured Codex model also appears in the ordinary model picker under
the Claude instance, labeled **via Codex**. Selecting it runs the main session on that Codex model
through Claude Code's compatible runtime, while preserving Claude Code tools, transcripts, and
session UI. In that mode the Claude-versus-Codex task preferences are skipped because the main loop
itself is already Codex; the Haiku slot remains available for native Codex subagents.

## Model Preferences

The main conversation remains on its selected Claude model, but its role is orchestration rather
than doing every substantial step inline. Model preferences choose which kind of subagent produces
each artifact. They are guidance injected into the session, not a hidden classifier in the server.

Each category that uses **Claude subagent** or **Best fit** has its own compact Claude model selector.
It uses Claude Code's stable `opus`, `fable`, or `sonnet` Agent alias while showing the corresponding
model name available from the selected Claude instance. Categories assigned only to Codex hide the
Claude selector because it would not affect that route.

Each work category can be assigned to:

- **Claude subagent** — the selected Claude Agent or Workflow model produces the planning, design,
  review, or other judgment-heavy artifact.
- **Codex subagent** — Codex produces the artifact through `model: "haiku"` with a self-contained
  prompt.
- **Best fit** — Codex handles self-contained, parallel, or mechanical work while a Claude
  subagent handles interactive, unknown-shape, or judgment-heavy work.

The balanced defaults use Codex subagents for exploration and clear-spec implementation, Claude
subagents for planning, design, review, and final-analysis drafts, and decide verification task by
task. The main session decomposes the request, coordinates parallel work, evaluates the evidence,
resolves disagreements, and writes the final answer. Tiny connective steps can remain inline.

**Independent second opinion** is a separate preference for consequential plans and reviews. The
Claude side uses the model selected for Planning & architecture or Review & final analysis,
respectively. A Claude and Codex subagent form blind independent views in parallel; the main session
adjudicates the disagreements. Routine work does not pay for the extra pass. The main session always
owns the final answer.

## Routing Prompt

The injected routing text has three separate layers:

1. fixed bridge mechanics, including the remapped slot and correct `Agent` syntax
2. the structured model preferences, or a custom replacement policy
3. optional additional instructions

The default **T3 preferences** policy tells Claude:

- which Codex model occupies the Haiku slot
- which model should own each category of work
- when an independent second opinion is required
- to send self-contained instructions to delegated agents
- to keep the main session as a thin orchestrator
- to fall back honestly if the bridge is unavailable

Choose **Custom policy** to replace only the model-preference policy, or **Bridge facts only** to
omit preference guidance. The fixed bridge mechanics remain present so Claude never mistakes the
remapped slot for real Anthropic Haiku. **Additional instructions** are appended in every mode. The
exact block is shown in the preview.

This routing block is added before rules from **Settings → System Prompt**. Claude Code's own system
prompt remains intact. Changes apply when a new provider session starts; an already-running thread
keeps its original routing setup.

## Runtime And Network Behavior

T3 downloads a pinned bridge runtime on demand and checks its SHA-256 digest before running it. The
bridge and routing proxy listen only on loopback and use random local credentials. Ordinary Claude
requests continue to the Claude instance's original Anthropic-compatible API URL; only recognized
Codex model IDs go to the local bridge.

If a new Claude session says the bridge is unavailable, return to **Settings → Model Routing** and
check that the bridge account is connected. Disconnecting the bridge removes its isolated local
credentials but does not sign out the normal Codex provider.
