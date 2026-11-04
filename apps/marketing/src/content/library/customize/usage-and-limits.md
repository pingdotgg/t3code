---
title: "Usage and limits"
description: "Track Claude and Codex usage in T3 Code, compare tokens and estimated costs, inspect provider subscription limits, and troubleshoot missing history."
updated: 2026-11-04
sources:
  - label: "Usage and limits"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
  - label: "Usage shortcuts"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md"
  - label: "How I code with AI changed a lot: personal usage discussion at 4:00"
    url: "https://www.youtube.com/watch?v=xJaMTo2YgO8&t=240s"
faq:
  - question: "Does T3 Code have its own Claude or Codex usage limits?"
    answer: "T3 Code displays the subscription allowances reported by connected provider accounts. The quota and reset windows come from the provider; T3 Code does not define a universal Claude or Codex allowance."
  - question: "How do I track Claude and Codex usage in T3 Code?"
    answer: "Open Usage from the T3 Code sidebar or command palette, or press mod+U outside the terminal on web and desktop. Use Cost and Tokens for history, and Limits for reported subscription allowances."
  - question: "Is the dollar total in T3 Code my subscription bill?"
    answer: "No. T3 Code shows estimated API-equivalent cost derived from usage history and model pricing. That estimate is not your subscription bill."
  - question: "Why is usage missing in T3 Code?"
    answer: "T3 Code totals depend on history available to each server, configured account directories, and provider support. Select the intended environments and refresh to rescan history and update model pricing."
  - question: "Does the same account count twice on two T3 Code machines?"
    answer: "In T3 Code Limits, the same account signed in on several environments or also reported by a hub counts once. Usage also avoids counting accounts sharing a history directory more than once."
---

T3 Code shows token usage, estimated API-equivalent cost, and subscription limits reported by connected provider accounts. Open **Usage** from the sidebar or command palette, or press `mod+U` outside the terminal on web and desktop. Limits come from the provider; the cost estimate is not your subscription bill.

## Choose between usage history and remaining allowance

Cost and Tokens describe recorded work. Limits describes provider-reported subscription capacity. Read the view that answers your immediate question.

| Your question                                 | View                              | How to interpret it                                             |
| --------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| Which models used the most tokens?            | Tokens and Breakdown              | Recorded usage in the selected history and environments.        |
| What would that work cost at model API rates? | Cost                              | An estimate, including cache and speed differences.             |
| How much subscription capacity remains?       | Limits                            | Reported provider windows, pooled across visible accounts.      |
| Is the current model close to a limit?        | `/usage-limits` or thread details | The relevant account reading from the existing limits snapshot. |

On mobile, open Usage through workspace navigation. On web and desktop, the environment dropdown filters costs, tokens, and limits. All environments are selected initially. Narrow it to one machine when you need to explain a difference between servers.

## Read token and cost breakdowns

Usage combines supported history from connected environments, including Codex and Claude Code. It also reads Grok Build, OpenCode, Antigravity, Pi, Muse Code, and Cursor data. The details available depend on each provider's records.

The view separates token types and speed, shows cache savings, and groups models. Select a model under **Breakdown** to inspect its trend, cache hit rate, and cost per million tokens. **Premium** shows the extra cost of Fast and Ultrafast requests above standard rates. **Other** holds cost that cannot be split, such as a provider-reported amount for a model without public rates.

Treat these figures as estimates of API-equivalent work. They do not establish what you owe on a subscription. Theo's personal usage discussion at 4:00 in _How I code with AI changed a lot_ includes a special allowance. It is not a quota promise for another account.

For the account relationship, read [using a Claude subscription](/learn/concepts/use-your-claude-subscription) and [using a ChatGPT plan with Codex](/learn/concepts/use-your-chatgpt-plan).

## Inspect Claude and Codex subscription limits

Open `Usage → Limits` to see provider windows across visible subscription accounts. T3 Code pools accounts per provider, so each window has one combined reading and one bar segment per account. Accounts retain the same column across windows.

A gap means an account does not report that window. When reset times are available, the card shows the next reset and the capacity it restores. Select a segment or account row for its plan, sign-in location, and reset time. On web, hovering also exposes details.

An account appearing on several environments or through a hub counts once. Use the environment dropdown to inspect a single machine's available accounts.

If a Claude or Codex account has exhausted its overall weekly quota, its pooled session contribution shows no remaining capacity. Session and weekly reset times both affect the next refill. Missing or stale reset times have no refill estimate. Claude's model-specific weekly allowances keep their separately reported values.

Check the live reading for your account before deciding whether to start more work. Provider-reported windows determine the remaining allowance.

## Refresh a stale reading

Opening Limits checks selected connected environments automatically. Each client waits at least five minutes between automatic checks of the same environment, including failed checks. Use manual refresh when you need a fresh provider or hub reading.

For history, the environment dropdown identifies servers still scanning. Results appear as each responds, and updating values are dimmed. Cursor shows saved totals before its account API response arrives.

If recent work or a model's cost is absent, refresh to rescan session history and update pricing. If the app and server support different providers, update the app to include newly supported providers. Use [the official download page](/download) when installing or updating the app.

## Check limits while staying in the conversation

Choose `/usage-limits` from the composer's command menu, or send it as a message. T3 Code shows the current model's limits above the composer until you dismiss the result or send the next message.

That command reads the same snapshot as Limits. It does not run an agent or refresh provider data. It is offered only for providers represented in Limits. Refresh the full view first if you need a newer snapshot.

For a persistent display on web and desktop, enable **Usage limits** in `Settings → Appearance → Thread details`, or use the thread details card's context menu. Enable **Context window** to show context use separately. Some limit windows apply only to one model. Hover a row for reset and pace information.

See [appearance settings](/learn/customize/appearance) for those controls and [keyboard focus](/learn/customize/keyboard-focus) for moving through the workspace without a mouse.

## Explain missing history before relying on a total

Totals reflect the history available on each server. They are not a reconstruction from every visible conversation. Cursor, for example, uses account usage from its API, and T3 Code does not invent missing token counts from conversation text.

Configured account homes affect discovery, including `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Use absolute or `~/` paths in account environment settings. Relative paths depend on project working directories and cannot be reliably discovered by Usage. Accounts sharing a history directory count once, and history from disabled accounts remains included.

Some runs leave no usable history. Text generation for titles, commit messages, PR text, branch names, and review guides is absent for Codex and Claude Code 2.0.63 and newer. Grok turns without a saved completed-turn record are absent too.

API-key accounts may not report subscription limits. Claude connections through an `ANTHROPIC_AUTH_TOKEN` proxy have that limitation as well. Missing limits therefore do not establish unlimited usage.

## Set custom prices for an unknown model

On web or desktop, open the Usage environment dropdown and choose **Model prices**. Enter the exact model ID and USD prices per million input and output tokens. Unknown-price models can also open that table through **Breakdown → Set price**.

Choose the destination environments under **Apply to**. Cache read and write rates are optional and use the input rate when blank. Saved rates replace automatic pricing across that environment's history and are shared with its connected clients.

**Map to** combines a model's tokens and cost with a target model and uses the target price. Clear the mapping to restore its separate entry. Use **Reset to automatic**, then save, to remove a pricing override.

Offline destinations show **Not saved**. Reconnect and choose **Retry failed saves** before closing the dialog. Changes are not queued after it closes. This destination behavior is another reason to understand [project and environment settings](/learn/customize/project-settings).

## Next steps

[Customize Usage shortcuts](/learn/customize/keybindings) for switching Cost, Tokens, Limits, and history periods.
Read [Claude subscription behavior](/learn/concepts/use-your-claude-subscription) or [ChatGPT plan connections](/learn/concepts/use-your-chatgpt-plan) for the provider you use.
Return to [settings and customization](/learn/customize) for the surrounding preferences.
