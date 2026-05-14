# Claude

This guide is for people who want to use more than one Claude setup in T3 Code.

Common reasons:

- use separate work and personal Claude accounts
- try a different Claude Code configuration without disturbing your main setup
- run Claude through a router such as Claude Code Router
- use external providers exposed through a Claude-compatible workflow

## I Only Use One Claude Account

Use the default provider.

Log in with Claude Code normally:

```bash
claude auth login
```

In T3 Code Settings, your Claude provider can stay like this:

```text
Display name: Claude
Binary path: claude
Claude HOME path: empty
```

An empty `Claude HOME path` means T3 Code uses your normal home directory.

## I Want Work And Personal Claude Accounts

Use a different Claude home for each account.

Example:

```text
default home                 work account
~/.claude_personal_home       personal account
```

### Set Up The First Account

Log in normally:

```bash
claude auth login
```

In T3 Code Settings:

```text
Display name: Claude Work
Binary path: claude
Claude HOME path: empty
```

### Set Up The Second Account

Log in with a separate home:

```bash
mkdir -p ~/.claude_personal_home
HOME=~/.claude_personal_home claude auth login
```

Then add another Claude provider in T3 Code:

```text
Display name: Claude Personal
Binary path: claude
Claude HOME path: ~/.claude_personal_home
```

Use the email shown in Settings to confirm each provider is using the intended account. Emails are
blurred by default; click the blurred email to reveal it.

## Can I Switch Claude Accounts In An Existing Thread?

Usually, no.

T3 Code only offers Claude providers that use the same Claude home for an existing thread. A
different Claude home is treated as a different Claude environment.

This is different from the recommended Codex setup. Claude Code keeps account and local state across
multiple files under its home directory, so T3 Code keeps separate Claude homes isolated instead of
trying to share part of the state.

## I Want To Use OpenRouter

Use this when you want Claude Code to talk to OpenRouter directly, without running a local router.
This is the simplest external-provider setup.

OpenRouter provides a Claude Code integration through Claude's Anthropic-compatible environment
variables.

### Configure A Claude OpenRouter Provider

Add or edit a Claude provider in T3 Code Settings:

```text
Display name: Claude OpenRouter
Binary path: claude
Claude HOME path: ~/.claude_openrouter_home
```

In that provider's Environment variables section, add:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive. T3 Code stores the value as a server secret and does not
send it back to the app after saving.

If you want this setup isolated from your normal Claude account, create that home first:

```bash
mkdir -p ~/.claude_openrouter_home
```

If you previously used the same Claude home with a normal Anthropic login, run `/logout` in a Claude
Code session for that home before using OpenRouter. Otherwise Claude Code may keep using cached
Anthropic credentials instead of the OpenRouter token.

### Pick OpenRouter Models

OpenRouter can route Claude Code's default model roles to OpenRouter model IDs.

Example:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

Add those to the same provider's Environment variables section if you want stable model choices.

### Verify OpenRouter Is Being Used

Open a Claude session and run:

```text
/status
```

You should see the Anthropic base URL set to:

```text
https://openrouter.ai/api
```

You can also check the OpenRouter activity dashboard for requests from your API key.

### Common OpenRouter Mistakes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
- Set `ANTHROPIC_AUTH_TOKEN` to your OpenRouter API key.
- Set `ANTHROPIC_API_KEY` to an empty string so Claude Code does not try to use an Anthropic login.
- Put these variables on the Claude provider instance, not in global shell startup files.

OpenRouter's setup can change over time. Use its upstream Claude Code guide for the current details:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## I Want To Use Claude Code Router

Claude Code Router is useful when you want a local routing layer with more control than a direct
OpenRouter setup.

T3 Code does not need a special Claude Code Router provider. Treat the router as a Claude
environment.

Use this when you want Claude Code Router to decide which upstream model or provider handles Claude
requests.

High-level flow:

1. Start Claude Code Router.
2. Add or configure a Claude provider in T3 Code.
3. Put the router's required variables on that provider instance.

Configure a Claude provider:

```text
Display name: Claude Router
Binary path: claude
Claude HOME path: ~/.claude_router_home
```

Then copy the variables that `ccr activate` would export into the provider's Environment variables
section. Mark tokens and API keys as sensitive.

If you want the router-backed setup to stay separate from your normal Claude account, create and log
in with a dedicated home first:

```bash
mkdir -p ~/.claude_router_home
ccr start
ccr activate
HOME=~/.claude_router_home claude auth login
```

Claude Code Router's setup can change over time. Use its upstream README for the current install and
configuration steps: <https://github.com/musistudio/claude-code-router>.

## I Want Different Claude Settings, Not A Different Account

Create another Claude provider with the same account if you want a named preset.

Examples:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

If the preset needs different Claude files, give it a different `Claude HOME path`. If it needs
different API keys, base URLs, or router settings, use Environment variables.

Do not put environment variable assignments in `Launch arguments`.
