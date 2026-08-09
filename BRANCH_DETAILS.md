# Default Sidebar Archive Controls

The default sidebar preserves archive as a separate lifecycle from settle. Settled rows expose adjacent un-settle and archive buttons on hover or keyboard focus, while root conversation context menus expose archive for both settled and unsettled rows. Archive remains visible but disabled while a provider session is starting or a turn or native background work is active, including monitoring-only work, and nested subagent rows continue to omit root lifecycle actions. The legacy sidebar shares the same active-work archive guard.

The collapsible `Settled` shelf header includes an `Archive all` action alongside its expansion control. It applies to the complete settled partition in the current project scope, including rows behind settled-tail pagination, and remains available when the list begins with settled conversations. Individual, selected, and all-settled archive actions honor the shared archive-confirmation setting, use the existing optimistic visibility and archived-snapshot refresh path, preserve already archived results if a later bulk mutation or post-archive navigation fails, remove archived rows from any active selection, and report failures without implying that completed archive work was rolled back. Every archive path coordinates its target threads from confirmation through mutation. Later overlapping flows wait for the current owner, omit threads it archived successfully or intentionally skipped after a live eligibility re-check, and retry threads it canceled or failed to archive instead of racing or silently dropping the later request. Waiting bulk flows reserve their uncontested sibling threads before awaiting current owners, so later requests cannot make their confirmation scope stale. Completed archives and intentional eligibility skips are published to waiters as they occur, even if a later mutation or navigation throws. Bulk flows also re-check live turn and background-work state after coordination and confirmation, while `Archive all` additionally re-checks settled-partition membership before each mutation. Entries that became active or were un-settled while a flow waited are skipped without aborting the remaining confirmed batch, and the user is warned about the skipped entries.

`SidebarArchiveControls.tsx` owns the fork-specific settled-row controls and shelf divider, `SidebarArchiveControls.logic.ts` owns the pure archive policy, eligibility, outcome, and coordination helpers, and `useSidebarArchiveActions.ts` owns confirmation, live rechecks, outcome reporting, and selection cleanup. `Sidebar.tsx` retains only the integration points in the upstream-owned row and list surfaces. The upstream `buildThreadActionMenuItems` builder owns root-menu composition and exposes an optional archive entry that only the default sidebar enables; the chat-header menu keeps its upstream action set. Shared lifecycle-button classes keep settle, un-settle, and archive affordances aligned with the upstream row surface tokens while upstream snooze and wake controls retain their own shelf semantics. The slim settled status slot mirrors upstream's `focus-visible` crossfade so its timestamp yields to both lifecycle buttons instead of remaining underneath them, while Woke stays visible and the controls move into flow beside it. Disabled archive controls retain pointer targeting so clicks cannot fall through to row navigation, and an in-flight `Archive all` remains mounted even after optimistic visibility removes every archivable row. The surrounding row structure, including tooltip wrapping, row sizing, pinned-thread sorting and dragging, filtering, and decorative environment/provider status semantics, remains upstream-owned. Upstream title-search mode uses separate navigation-only result rows and temporarily replaces the normal lifecycle list; clearing search restores the settled divider and row archive controls. The settled divider remains an interactive list item rather than an aria-hidden separator because it contains both the shelf toggle and `Archive all`.

Primary files:

- `apps/web/src/components/LegacySidebar.tsx`
- `apps/web/src/components/Sidebar.logic.ts`
- `apps/web/src/components/Sidebar.logic.test.ts`
- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/SidebarArchiveControls.tsx`
- `apps/web/src/components/SidebarArchiveControls.logic.ts`
- `apps/web/src/components/SidebarArchiveControls.logic.test.ts`
- `apps/web/src/components/SidebarArchiveControls.test.tsx`
- `apps/web/src/components/threadActionMenu.logic.ts`
- `apps/web/src/components/threadActionMenu.logic.test.ts`
- `apps/web/src/hooks/useSidebarArchiveActions.ts`
- `apps/web/src/hooks/useThreadActions.ts`
- `apps/web/src/hooks/useThreadActions.test.ts`

## Development Ports

- Web: `5743`
- Server/WebSocket: `13783`
