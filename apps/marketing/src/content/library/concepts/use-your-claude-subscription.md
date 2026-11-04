---
title: "Use your Claude subscription in T3 Code"
description: "Connect T3 Code to your existing Claude Code login, keep account configurations separate, and understand where subscription limits come from."
updated: 2026-11-04
sources:
  - label: "Theo explains the official Claude Code integration"
    url: "https://www.youtube.com/watch?v=RIkSlHgQYog&t=360s"
  - label: "Theo discusses subscription workflows"
    url: "https://www.youtube.com/watch?v=D8PikZ1KhUo&t=0s"
  - label: "Claude provider guide"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Provider installation"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Usage and subscription limits"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
  - label: "Anthropic Claude Code overview"
    url: "https://code.claude.com/docs/en/overview"
  - label: "Anthropic consumer terms"
    url: "https://www.anthropic.com/legal/consumer-terms"
  - label: "Anthropic subscription access and limits"
    url: "https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan"
faq:
  - question: "Can I use Claude Pro or Max in T3 Code?"
    answer: "T3 Code uses your existing Claude Code login and configuration. Sign in through the official Claude Code CLI with an account that has Claude Code access; Anthropic controls plan eligibility and limits."
  - question: "Do I need an Anthropic API key for T3 Code?"
    answer: "T3 Code can use an existing Claude Code subscription login. An API-key or router configuration is a separate connection choice, so check the account and environment settings you select."
  - question: "Does T3 Code give Claude subscribers unlimited usage?"
    answer: "T3 Code does not grant additional Claude subscription allowance. Anthropic controls usage limits, and T3 Code displays reported limits under Usage."
  - question: "Where do I sign in for a remote Claude environment?"
    answer: "T3 Code uses the Claude configuration on the connected server. Run the Claude Code login on that environment's machine and check the reported account in provider settings."
---

T3 Code uses your existing Claude Code login and configuration, so you can connect an account with Claude Code subscription access. For a Claude Pro or Max account, sign in through the official Claude Code CLI on the machine running the agent. Anthropic's current eligibility, terms, and limits govern that access.

## How does the subscription connection work?

Theo explains the approach at 6:00 in [I need you guys to trust me on this](/learn/videos/trust-me-on-this). T3 Code uses the official Claude integration to access the local Claude Code CLI. In his explanation, T3 Code supplies another interface around that runtime.

The current provider guide establishes the practical part: T3 Code uses Claude Code's login and configuration. You do not need to move your conversation workflow into the terminal to use that login in T3 Code. You do need the official runtime and its authentication on the environment that executes your work.

Theo also discusses subscriptions and parallel work in [If you have a Claude sub, watch this](/learn/videos/if-you-have-a-claude-sub). Treat the video's prices and usage comparisons as historical discussion. Check [Anthropic's current terms](https://www.anthropic.com/legal/consumer-terms) and [subscription access guidance](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan) for your plan's rules and limits.

## How do you connect Claude Code?

1. [Download T3 Code](/download) if you have not installed it.
2. Install the official Claude Code CLI on the environment's machine.
3. Run the login command there and complete the provider's sign-in flow.
4. Open `Settings → Providers` in T3 Code on web or desktop.
5. Select that environment and enable Claude.
6. Check the account reported in provider settings before starting work.

```bash
claude auth login
```

If T3 Code cannot find the installed CLI, check its `PATH` on the server. Set `Binary path` in provider settings when the executable lives outside the server's normal search path. This is especially relevant when you installed Claude through a version manager.

If you expected subscription access but see API usage, inspect the instance's environment variables and active account. The Claude provider guide warns that cached logins can conflict with router credentials. Check that configuration before attributing an unexpected charge to T3 Code.

A remote connection uses the remote server's Claude setup. A successful login on your laptop does not establish the login on another environment. The [Claude Code provider guide](/learn/providers/claude-code) covers provider-specific configuration.

## How do you keep work and personal accounts separate?

Use a separate Claude configuration directory for the second account. Keep the existing account in its default directory, then authenticate the second one with the same directory variable that its T3 Code instance will use:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in `Settings → Providers`. Keep its `Binary path` set to `claude` and set its `CLAUDE_CONFIG_DIR path` to `~/.claude_personal`. Leave that field empty on the default instance to use Claude Code's normal configuration.

The custom directory setting changes `CLAUDE_CONFIG_DIR`; it leaves `HOME` and the system keychain location intact. Do not substitute a changed `HOME` for this setup, because credentials can end up where the provider will not find them.

| You need                                        | Configuration choice                     |
| ----------------------------------------------- | ---------------------------------------- |
| One existing account                            | Start with the default Claude provider   |
| A separate account and local conversation state | Use a separate Claude config directory   |
| A preset with different API keys or endpoints   | Use the instance's environment variables |

Existing Claude threads can switch only between instances with the same configuration directory. Separate account directories remain isolated. Check that constraint before expecting a second account to continue an existing thread.

## What happens when the plan reaches a limit?

Open `Usage → Limits` to inspect the subscription information T3 Code can retrieve. When the provider reports reset times, T3 Code shows them. API-key accounts and some proxy configurations may not report subscription limits.

The Claude provider guide says an exhausted subscription can hold a turn until its usage window reopens. A thread can therefore continue to show as working. Read the limit message and its timestamp, then wait for the reset or stop the turn and continue later.

The estimated API-equivalent cost in Usage is not your subscription bill. Use [Usage and limits](/learn/customize/usage-and-limits) to understand the display. For exact entitlements, prices, and plan restrictions, rely on Anthropic's current account information.

## Next steps

Continue with [the Claude provider setup](/learn/providers/claude-code) or compare [the ChatGPT connection](/learn/concepts/use-your-chatgpt-plan).

Return to [Ideas behind T3 Code](/learn/concepts) for the relationship between your account, runtime, and interface.
