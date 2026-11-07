# GitHub Copilot

T3 Code can run GitHub Copilot as its own provider, using the Copilot CLI you already have. This is
separate from Copilot in the [ACP Registry](./providers-acp.md), which keeps working as before.

GitHub Copilot is an early-access provider, and it relies on an experimental Copilot API.

## Set it up

1. Install the [GitHub Copilot CLI](https://github.com/github/copilot-cli).
2. Run `copilot login`.
3. Enable **GitHub Copilot** in **Settings > Providers**.

If `copilot` is not on your `PATH`, set **Binary path** in the provider's settings.

## Steering a running turn

Send a follow-up while Copilot works, with or without images. It stops the tool the main agent is
running and answers right away, while background agents keep working.

## Approvals

When Copilot asks to run something, type a reason in the composer to decline with feedback. Copilot
reads the reason and carries on.

## Plans

In Plan mode, Copilot's plan appears as a proposal and it waits for you. Choose **Implement** to run
it, or send feedback to refine it.

## Reasoning

Models that support it show a **Reasoning** level in the model picker.

## Rewind, forks, compaction, and commands

- **Edit from here** rewinds the conversation, and Copilot forgets the turns you removed.
- Fork a thread from any Copilot response.
- `/compact` compacts the conversation.
- Copilot's own slash commands appear in the composer.

## MCP Apps

MCP tools that come with an interface show it in the thread.

## Background agents

Stop a running background agent from **Lineage** without ending the turn.

## Generated text

Copilot can write thread titles, commit messages, branch names, pull request titles and
descriptions, and review guides when you select it for text generation in **Settings**. It is not
chosen automatically, because generated text uses your Copilot quota.

Review guides can only read the checkout and run `git diff`, `git log`, and `git show`. They are not
available on Windows, so choose another model for them there.

## If Copilot reports it is not compatible

T3 Code needs a Copilot CLI that speaks the same protocol. If it says yours does not, update Copilot.
