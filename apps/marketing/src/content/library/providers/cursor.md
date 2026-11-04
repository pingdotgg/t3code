---
title: "Use Cursor in T3 Code"
description: "Connect Cursor to T3 Code through browser sign-in or an API key, configure local MCP access, and understand SDK approvals and Windows limits."
updated: 2026-11-04
sources:
  - label: "Cursor SDK setup and limitations"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/cursor.md"
  - label: "Cursor usage"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md"
  - label: "Cursor SDK runtime"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-cursor/src/server/CursorAgentSdk.ts"
  - label: "Cursor SDK authentication status"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-cursor/src/server/status.ts"
  - label: "Portable handoff context"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/portable-handoffs.md"
  - label: "Handoff message selection"
    url: "https://github.com/pingdotgg/t3code/blob/main/packages/provider-core/src/server/handoffBudget.ts"
faq:
  - question: "Does T3 Code run the Cursor editor?"
    answer: "T3 Code runs Cursor through the @cursor/sdk local-agent runtime in your selected workspace. It does not run Cursor cloud agents or use ACP for V2 execution."
  - question: "Do I need a paid Cursor plan for T3 Code?"
    answer: "T3 Code's documented Cursor SDK connection requires a paid Cursor plan on the account used for browser sign-in or CURSOR_API_KEY."
  - question: "Does T3 Code inherit my Cursor editor login?"
    answer: "T3 Code keeps a login per Cursor provider instance on the environment. Your Cursor editor and CLI login are separate; CURSOR_API_KEY overrides browser sign-in."
  - question: "Why does Cursor MCP OAuth fail in T3 Code?"
    answer: "The Cursor local SDK cannot complete interactive MCP OAuth. Run agent mcp login <server> from the project root on the environment, then restart the T3 Code agent session."
---

T3 Code runs Cursor through the `@cursor/sdk` local-agent runtime in your selected workspace. Cursor is a coding-agent provider; its T3 Code connection needs Node.js 22.13 or newer and a paid Cursor account authenticated through browser sign-in or `CURSOR_API_KEY`.

## Sign in to Cursor from provider settings

1. [Install T3 Code](/download) and select the environment containing your project.
2. Open `Settings > Providers > Cursor`.
3. Choose `Sign in`, open the sign-in page, and complete the browser flow.
4. Wait for T3 Code to update the provider after sign-in.
5. Choose an SDK-supported model in the thread's model picker.

The browser flow also works with remote environments. On mobile, `Settings > Providers` supports sign-in for an already configured Cursor instance.

Each instance keeps its login on the environment where it runs. Your editor and CLI login are separate. To use an API key, set `CURSOR_API_KEY` for the instance. That key takes priority over browser sign-in, so remove the override when returning to the browser account.

`Change account` and `Sign out` stop the instance's running threads and retain history. Signing out forgets the saved credential. To revoke the generated key before expiry, remove it in your Cursor dashboard's API keys.

## Understand the local SDK connection

The V2 integration executes locally in the T3 Code workspace. It does not expose the repository and cloud-environment configuration needed for Cursor cloud agents.

The provider's older binary-path and API-endpoint settings belong to the CLI/ACP integration. V2 execution does not launch that binary, and the SDK does not expose an endpoint override. Changing those settings does not redirect V2 execution.

| Task                              | Cursor behavior in T3 Code                 |
| --------------------------------- | ------------------------------------------ |
| Select `auto`                     | Sends the SDK's `default` model choice     |
| Continue a local conversation     | Uses SDK create and resume support         |
| Change model parameters           | Applies changes between turns              |
| Send a message during active work | Uses interruption and restart for steering |
| Fork a Cursor thread              | Hands context into a fresh agent           |

The native SDK has no conversation rollback or native agent fork. Read [portable handoffs](/learn/threads/portable-handoffs) when exact instructions must survive a fork: selected messages retain their full text, but some messages can be omitted to fit the budget.

## Choose permissions with the SDK limits in mind

Full access disables Cursor's SDK sandbox. Restricted modes normally enable it. Cursor Auto-review uses SDK controls rather than interactive approval callbacks in the T3 Code conversation.

Windows has a specific constraint: the local SDK does not support filesystem sandboxing there. Auto and Supervised can run without filesystem isolation when Auto-review is enabled. Restricted modes without Auto-review, including the default Auto-accept edits behavior, still request a sandbox and cannot start on Windows. Explicit sandbox policies remain authoritative, including policies that the Windows SDK rejects.

Check [permission modes](/learn/safety/permission-modes) before treating a mode label as proof of filesystem isolation. The SDK's available controls determine what Cursor can enforce.

## Load Cursor MCP servers, plugins, and skills

Cursor loads custom configuration from the environment machine when its agent opens. MCP configuration comes from project `.cursor/mcp.json` and user `~/.cursor/mcp.json`. Installed plugins come from `~/.cursor/plugins`.

Plugin tools can appear without login, but OAuth MCP servers still require credentials. Authenticate a server in a terminal with the project root as the working directory:

```bash
agent mcp login <server>
```

This writes credentials under `~/.cursor/projects/<folder-slug>/mcp-auth.json`. Cursor desktop Connections authentication does not write that file. An SDK message saying MCP authentication is unsupported therefore calls for CLI authentication in the correct project, not another attempt inside the running SDK session.

After changing skills, plugins, or MCP servers, or completing that CLI login, choose `Restart agent session`. The next session loads the changed configuration.

## Inspect native Cursor tasks and usage

Cursor task subagents appear as read-only child threads with their activity and final result. Send follow-up messages through the parent. The task's native `agentId` is not resumable through the local SDK, so the projected child is not an independent chat you can resume.

T3 Code's [Usage page](/learn/customize/usage-and-limits) reads Cursor account usage from its API. The totals can include headless and desktop usage across machines. The same account counts once across connected environments. Missing credentials produce a notice; T3 Code does not infer missing tokens from conversation text.

## Next steps

- Compare the [Claude Code, Codex, and Cursor workflows](/learn/concepts/claude-code-vs-codex-vs-cursor).
- Review all [coding agents](/learn/providers) or the separate [ACP agent connection](/learn/providers/acp-agents).
- Follow [remote access setup](/learn/remote/remote-access) when the environment runs on another machine.
