---
name: how
description: Explains how a subsystem works at senior-engineer onboarding depth. Use when the user asks how does X work, for code walkthroughs before changing something, or placement and layering questions like where should this live or is this the right layer. Use why for motivation.
---

# How

Adapted from [backnotprop/pstack](https://github.com/backnotprop/pstack) `how` (MIT).

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

## Step 1. Assess Complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): no explorers. One explainer explores and explains in a single pass. Go to Step 2b.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): spawn parallel explorers first, then hand off to the explainer. Go to Step 2a.

When in doubt, take the simple path.

Spawn explorers and synthesizers with parallel subagents when available (for example `delegate_work` here, `Agent` in Claude Code, `task` in OpenCode, `spawn_agent` in Codex). Without a subagent tool, run each role yourself sequentially. Prefer diverse models for explorers versus the synthesizer when the harness allows model choice; otherwise inherit the parent model.

## Step 2a. Explore (complex questions only)

Decompose the question into 2 to 4 exploration angles, each a distinct slice of the subsystem. Spawn all explorers in a single message when the harness supports it.

Each explorer gets the prompt in `references/explorer-prompt.md` with its angle filled in. Then go to Step 3.

## Step 2b. Direct Explain (simple questions)

Have one subagent explore and explain in one pass (or do it directly when working without subagents).

Build its prompt from `references/explainer-prompt.md` without the explorer-findings section. Go to Step 4.

## Step 3. Synthesize (complex questions only)

Once all explorers have returned, have one subagent synthesize their findings into one explanation (or synthesize directly when working without subagents).

Build its prompt from `references/explainer-prompt.md` with every explorer's findings filled in.

## Step 4. Present

Present the explainer's output to the user. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.

## Output Format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
