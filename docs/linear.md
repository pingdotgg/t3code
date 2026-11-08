# Linear in T3 Code

Open **Linear** in the sidebar or command palette. It connects directly to Linear’s GraphQL API from your T3 server. The desktop and web workspace includes inbox, assigned/created/subscribed issues, triage, search, lists and boards, projects, milestones, cycles, documents, comments, subissues, relationships and private attachments. **Start work** opens a new T3 task with the issue’s identifier, URL and description.

## Connect

On the Linear page, open connection settings and save a personal API key. The server validates the key before replacing a working connection. The key stays in the environment’s secrets directory with owner-only permissions; it is never returned to clients or agents. Alternatively, set `LINEAR_API_KEY` in the server environment. Personal keys use their own permissions and workspace; changing the connected account changes the workspace visible to everyone who can read that T3 environment.

Disconnect explicitly disables the connection, including an environment key. **Use environment key** removes the saved override. Each T3 environment has an independent connection. Existing clients may need to reconnect to receive the new **Change Linear** grant; credential changes need **Change environment settings**. Read-only clients can browse. Older T3 servers must be updated before this page can connect.

## Work

Choose a team to expose its statuses, labels, projects and cycles. Search or filter issues, open details, and use **Edit** for assignment, priority, estimates, due dates and relationships. Board cards can move between statuses within the selected team. Lists and boards show one page at a time; use **Next page** to continue. Issue discussions and document libraries also paginate.

Descriptions, comments and documents accept Markdown and support previews. File uploads use Linear’s private storage and are limited to 8 MiB per file. Read responses have temporary download links; edits preserve the permanent asset URLs. Issue archive can be reversed with **Restore**. Inbox supports read/unread, archive/restore and one-day snooze. Projects support overview editing, milestones and project documents; the Documents view also supports team documents.

The native Linear tab covers issue search, triage, issue editing, discussion and basic inbox actions, using the same environment connection. The web workspace provides the broader planning controls. Active issue and inbox queries refresh every minute; manual refresh is available.

## Agents

T3’s MCP server exposes `linear_workspace`, `linear_team`, `linear_issues`, `linear_issue`, `linear_comments`, `linear_projects`, `linear_project`, `linear_documents`, `linear_document`, `linear_inbox` and `linear_mutate`. Agents use the saved connection without handling its key. The usual MCP caller restrictions apply; read-only and linked callers cannot mutate this workspace. Use `attachmentCreate` to attach a PR URL to an issue.

Writes are not automatically retried. A network failure can occur after Linear accepted a change. Check the record before repeating a create or comment. API permissions, workspace policy and rate limits still apply.

This integration covers development work and planning. Workspace administration, billing, automations, dashboards, initiatives, customer management and custom issue fields continue to require their respective Linear features.

## Development checks

Run the focused server tests in `apps/server/src/linear` and `apps/server/src/mcp/toolkits/linear`, plus authorization, client permissions and navigation checks. Run `vp run check:changed --concurrency 1` before pushing. Model workflow cases live in `evals/mcp-tool-use/cases/linear.ndjson`. Live API verification should use temporary issues and projects in a test workspace, and remove those fixtures afterward. Never commit keys, signed URLs or real workspace data.
