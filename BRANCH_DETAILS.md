# Archive Settings UX

The settings Archive panel uses a dense layout so large archives remain scannable. The native mobile Archived Threads screen mirrors the same information hierarchy and behavior with mobile-native project sections, swipe actions, long-press menus, and header controls.

Expected behavior:

- Archived conversations are grouped by project, and each project group is collapsed by default.
- The Archive panel fetches archived thread snapshots from all configured environments, not only environments that currently have active projects, so archived-only workspaces remain visible, while active rows returned in those snapshots remain excluded from archive content and empty-state counts.
- Web project headers show environment labels whenever multiple environments are configured and keep a sole remote environment labeled, while a sole primary environment remains implicit.
- The page includes a search box that filters archived thread titles across all projects case-insensitively. Multi-word searches match any term, rank exact phrase matches first, rank titles matching every term ahead of partial term matches, and auto-open matching project groups while search is active.
- Expanded project headers include sortable `Archived` and `Created` columns; clicking either header toggles ascending/descending order for the conversations inside each group, with `Archived` descending as the default.
- Native project-section ordering follows the selected archive sort field and direction. Invalid archived timestamps fall back to the conversation's created timestamp for sorting and display on both surfaces.
- Native bulk actions distinguish rows skipped because the same thread action is already in progress from commands that actually fail, and report both outcomes accurately.
- Web row and project actions reserve collision-safe per-thread locks before confirmation, expose busy state only after confirmation, disable overlapping controls while mutations run, give explicit feedback for rejected duplicates, and refresh archived snapshots once after bulk attempts instead of between concurrent mutations.
- Conversation rows show only the relative archived and created ages inline with the title by default. On web row hover or keyboard focus, those age labels fade out and icon-only unarchive/delete actions appear as a right-side overlay with tooltips, matching the sidebar and source-control list-row action pattern. Native rows keep both age columns visible and expose the same actions through swipe gestures and the standard long-press context menu.
- Archived conversations can be deleted directly from the Archive panel without unarchiving first. Web delete actions respect the shared `confirmThreadDelete` client setting, while native keeps its standard guarded delete flow.
- Project group context menus expose `unarchive all` and `delete all` actions. While search is active, those bulk actions apply to the visible matching archived conversations and use matching-specific menu labels; otherwise they apply to all archived conversations in the project. Delete confirmations respect `confirmThreadDelete` on web and remain explicitly guarded on native; unarchive bulk actions remain guarded on both surfaces, and partial failures surface as not-fully-completed feedback instead of implying every archived thread failed.
- Archive grouping, search ranking, sort state, and project bulk-action concurrency live in `apps/web/src/components/settings/SettingsPanels.logic.ts` on web and `apps/mobile/src/features/archive/archivedThreadList.ts` on native so the dense Archive behavior stays covered without growing the React components. Project groups expose and reuse collision-safe keys so project ids containing separator characters do not collapse expansion state or React row identity. Bulk actions stop scheduling new work after thrown failures, wait for active workers to settle, show incomplete-operation feedback, and surface the underlying exception messages instead of only a generic aggregate error. The Archive surfaces refresh archived threads after bulk unarchive/delete attempts even when the action runner throws.

Primary files:

- `apps/web/src/components/settings/ArchiveSettings.tsx`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `apps/web/src/components/settings/SettingsPanels.logic.ts`
- `apps/mobile/src/features/archive/ArchivedThreadsRouteScreen.tsx`
- `apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx`
- `apps/mobile/src/features/archive/archivedThreadList.ts`

## Development Ports

- Web: `5734`
- Server/WebSocket: `13774`
