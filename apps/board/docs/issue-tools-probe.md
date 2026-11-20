# Issue tools probe

A probe on 2026-11-20 tested T3's issue tools and approval behavior on an isolated T3 0.1.10 engine. It used Claude Code 2.1.309 with `claude-haiku-5-5`, Codex with `gpt-5.6-luna`, and throwaway projects. No tracker was connected, so a write that reached T3's handler returned "Project <id> was not found or has no issue tracker." That error proves the handler ran.

## Results

| Question | Result |
| --- | --- |
| Which issue tools does a Claude thread have? | Eight, from the `t3-code` server: `mcp__t3-code__list_issues`, `read_issue`, `create_issue`, `comment_on_issue`, `set_issue_state`, `link_issue`, `unlink_issue`, and `list_thread_issues`. They are deferred, so the agent loads them through ToolSearch first. Claude Code's transcript lists 77 `mcp__t3-code__*` tools in all. |
| Do writes need approval in `full-access`? | No. `set_issue_state` and `create_issue` both reached the handler, with no approval item and no runtime request on the thread. |
| Do writes need approval in `approval-required`? | No. With no permission rule, `set_issue_state` ran with no approval. The runtime mode alone does not gate T3's tools. |
| Does a Claude ask rule gate them? | Yes, in both modes. `{"permissions":{"ask":["mcp__t3-code__set_issue_state"]}}` in the project's `.claude/settings.json` held the call as a pending runtime request with an `approval_request` item, shown in the shell stream's `pendingRuntimeRequest`. Accepting it ran the call. Declining was not tested. |
| Does the operator's `omp-kit` Linear rule catch them? | No. The rule's scope is `tool:write, tool:bash`, so its hook stays silent for every MCP tool. A replay of the hook script gave no output for T3's two write tools or for `mcp__linear__save_issue`, and it denied `Bash` and `Write` payloads that mention Linear. |
| Which issue tools does a Codex thread have? | The same eight, named `mcp__t3_code__*` with an underscore, read from Codex's own tool list. Codex also has `mcp__codex_apps__linear_*` tools, including `linear_save_issue`. |

## What this changes

- A Claude ask rule must name the hyphenated `mcp__t3-code__` tools. A Codex rule must name the underscored `mcp__t3_code__` tools.
- A pending approval shows on the shell stream's thread, not on `projection.thread`.
- The approval caused by an ask rule in `full-access` reports `fullAccessOverride: "provider_check"`.
