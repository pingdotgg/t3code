# Archive Settings UX

The settings Archive panel uses a dense layout so large archives remain scannable.

Expected behavior:

- Archived conversations are grouped by project, and each project group is collapsed by default.
- The Archive panel fetches archived thread snapshots from all configured environments, not only environments that currently have active projects, so archived-only workspaces remain visible.
- The page includes a search box that filters archived thread titles across all projects case-insensitively. Multi-word searches match any term, rank exact phrase matches first, rank titles matching every term ahead of partial term matches, and auto-open matching project groups while search is active.
- Expanded project headers include sortable `Archived` and `Created` columns; clicking either header toggles ascending/descending order for the conversations inside each group, with `Archived` descending as the default.
- Conversation rows show only the relative archived and created ages inline with the title by default. On row hover or keyboard focus, those age labels fade out and icon-only unarchive/delete actions appear as a right-side overlay with tooltips, matching the sidebar and source-control list-row action pattern.
- Archiving removes the conversation from the active UI optimistically while durable cold-storage work continues in the server background. Failed archive dispatch or post-click navigation reveals the row again, while a successful archive still refreshes the archived snapshot if navigation failed. Web and mobile unarchive actions show a per-conversation loading spinner and disable competing unarchive/delete/swipe actions until the request settles.
- Archived conversations can be deleted directly from the Archive panel without unarchiving first, and delete actions respect the shared `confirmThreadDelete` client setting.
- Project group context menus expose `unarchive all` and `delete all` actions. While search is active, those bulk actions apply to the visible matching archived conversations and use matching-specific menu labels; otherwise they apply to all archived conversations in the project. Delete confirmations respect `confirmThreadDelete`, unarchive bulk actions remain guarded, and partial failures surface as not-fully-completed toasts instead of implying every archived thread failed.
- Archive grouping, search ranking, sort state, and project bulk-action concurrency live in `apps/web/src/components/settings/SettingsPanels.logic.ts` so the dense Archive panel behavior stays covered without growing the React component. Project groups expose and reuse collision-safe keys so project ids containing separator characters do not collapse expansion state or React row identity. Bulk actions stop scheduling new work after thrown failures, wait for active workers to settle, and report interrupted counts separately from visible failures. Unexpected bulk-action exceptions still show incomplete-operation feedback, and the Archive panel refreshes archived threads after bulk unarchive/delete attempts even when the action runner throws.

Primary files:

- `apps/web/src/components/settings/ArchiveSettings.tsx`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/components/settings/SettingsPanels.logic.ts`

## Development Ports

- Web: `5734`
- Server/WebSocket: `13774`
