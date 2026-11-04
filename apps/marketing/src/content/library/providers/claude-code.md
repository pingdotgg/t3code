---
title: "Use Claude Code in T3 Code"
description: "Connect Claude Code to T3 Code with your existing login, configure separate accounts, and understand skills, approvals, compaction, and limits."
updated: 2026-11-04
sources:
  - label: "Provider setup"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md"
  - label: "Permission modes"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md"
  - label: "Claude configuration and accounts"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md"
  - label: "Model catalog"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/model-manifest.md"
  - label: "Welcome wizard"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/welcome-wizard.md"
  - label: "Theo on Claude subscription support"
    url: "https://www.youtube.com/watch?v=RIkSlHgQYog&t=0s"
faq:
  - question: "Can I use my Claude subscription with T3 Code?"
    answer: "T3 Code uses your Claude Code login and configuration, including an existing subscription login. Authenticate Claude Code on the machine running your selected environment."
  - question: "How do I use two Claude accounts in T3 Code?"
    answer: "Give each T3 Code Claude instance its own CLAUDE_CONFIG_DIR and sign in with that same variable. Existing threads can switch only between instances using the same config directory."
  - question: "Why does Claude ask for approval in Full access?"
    answer: "T3 Code Full access does not override Claude settings that disable bypass permissions or require approval. Claude also retains dangerous-removal safety checks."
  - question: "Can I compact Claude conversations in T3 Code?"
    answer: "T3 Code supports /compact and a provider setting named Auto-compact after. That setting changes compaction timing, not the model context window."
---

T3 Code runs Claude Code using the login and configuration on your selected environment. Claude Code is Anthropic's coding agent; install it and authenticate it there before choosing Claude in a T3 Code thread.

## Connect your existing Claude Code login

1. [Install T3 Code](/download), then select the machine where your project lives.
2. Install [Claude Code](https://claude.com/product/claude-code) on that machine through its installer.
3. Run `claude auth login` in a terminal on that machine.
4. Open `Settings > Providers`, enable Claude, and refresh provider status.
5. Check the reported account before starting work.

If T3 Code cannot find `claude` on the server's `PATH`, set the instance's `Binary path`. A remote connection uses the remote server's Claude configuration. Signing in on the device displaying the interface does not configure a separate server.

The [welcome wizard](/learn/start/welcome-wizard) checks Claude Code and Codex during setup. It can offer the installation or login command in a terminal configured for the selected provider instance.

## Choose subscription login or API configuration

For an existing subscription, use Claude Code's own login. T3 Code does not turn that subscription into a general API account. Theo demonstrates subscription support in [I need you guys to trust me on this](/learn/videos/trust-me-on-this). That demonstration does not establish provider endorsement or guarantee future account policy.

For configurations that differ by API keys or endpoints, put assignments in the instance's `Environment variables`. Mark credentials Sensitive. Do not put assignments in `Launch arguments`.

The documented OpenRouter setup uses a separate Claude instance with `ANTHROPIC_BASE_URL` set to `https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN` holding the router key, and an explicitly empty `ANTHROPIC_API_KEY`. If that config directory has a cached Anthropic login, run `/logout` in Claude Code using that directory first. Check the model in the router's activity dashboard after sending a request.

## Keep Claude accounts separate

Keep the first account in Claude's normal directory. Sign the second account into a new directory on the environment:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another instance in `Settings > Providers`. Keep its binary as `claude` and set its `CLAUDE_CONFIG_DIR path` to `~/.claude_personal`. Leave that field empty for the default account.

Use `CLAUDE_CONFIG_DIR` for both login and execution. Changing `HOME` can move credentials somewhere this integration does not look. The config-directory setting leaves the system keychain location intact.

| Goal                                                     | Configuration                                     |
| -------------------------------------------------------- | ------------------------------------------------- |
| Use the normal Claude account                            | Leave the config-directory field empty            |
| Isolate another account and local conversations          | Use a separate `CLAUDE_CONFIG_DIR`                |
| Continue an existing Claude thread with another instance | Both instances must use the same config directory |

Claude has no Codex-style shadow home. Compare [Codex account setup](/learn/providers/codex) before applying the same directory pattern to both providers.

## Control approvals for Claude tools

Select the thread's permission mode in the composer. Claude supports automatic review in Auto, while Full access allows commands and edits without ordinary approval prompts.

Claude can still ask when its settings disable bypass permissions or require approval for an action. Dangerous-removal checks can reject a command even in bypass mode. When the warning provides a safe rewrite, Claude can use it; otherwise it continues without that removal and reports what it skipped.

While an approval is pending, a text reply declines that request and gives feedback to the agent that asked. This includes subagents. Other pending requests remain unanswered. Read the [permission guide](/learn/safety/permission-modes) before changing the default for new threads.

## Manage skills, models, and long conversations

Claude skills come from the config directory's `skills` folder and the project's `.claude/skills`. The config-directory copy wins when names collide. Disabled skills stay out of the composer; enabled installed plugins can contribute names such as `plugin:review`.

Choose skills with `$`. Invoke manually reserved skills one per message, because Claude directly runs only the last named skill. Its Skill tool refuses earlier skills reserved for manual invocation.

Set `Auto-compact after` to an integer from `100000` to `1000000`, or leave it empty for Claude's default. Send `/compact` for manual compaction. Under `Settings > Providers > Advanced`, `Compact idle threads` controls large idle conversations. Its choices are `When you return`, `Before the cache expires (beta)`, and `Never`. A Compact chip can summarize expired-cache history before sending; switch it to Keep when you need the full history for that message.

Claude's built-in model catalog comes from T3 Code's model manifest. A custom router model can be added by full model ID under `Add custom model`; it may expose fewer controls.

## Diagnose login and usage problems

First compare the account shown in settings with the config directory used at login. For a router, check for a conflicting cached login and verify the explicit model selection.

When a subscription limit is reached mid-turn, Claude Code can hold the turn until the window reopens. A working indicator can therefore persist during the wait. T3 Code shows the limit and remaining wait when Claude supplies a reset time. Wait, or stop and continue later. [Usage and limits](/learn/customize/usage-and-limits) explains the difference between quota and estimated cost.

## Next steps

- Read how to [use your Claude subscription](/learn/concepts/use-your-claude-subscription) and Theo's [subscription workflow video](/learn/videos/if-you-have-a-claude-sub).
- Compare [Claude Code, Codex, and Cursor](/learn/concepts/claude-code-vs-codex-vs-cursor) or return to [coding agents](/learn/providers).
- Check [portable handoffs](/learn/threads/portable-handoffs) before moving context between providers, including [ACP agents](/learn/providers/acp-agents).
