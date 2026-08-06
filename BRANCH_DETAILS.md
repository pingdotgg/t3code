# Sidebar V2 Archive Controls

Sidebar V2 preserves archive as a separate lifecycle from settle. Settled rows expose adjacent un-settle and archive buttons on hover or keyboard focus, while root conversation context menus expose archive for both settled and unsettled rows. Archive remains visible but disabled while a turn or native background work is active, including monitoring-only work, and nested subagent rows continue to omit root lifecycle actions.

The collapsible `Settled` shelf header includes an `Archive all` action alongside its expansion control. It applies to the complete settled partition in the current project scope, including rows behind settled-tail pagination, and remains available when the list begins with settled conversations. Individual, selected, and all-settled archive actions honor the shared archive-confirmation setting, use the existing optimistic visibility and archived-snapshot refresh path, preserve already archived results if a later bulk mutation or post-archive navigation fails, remove archived rows from any active selection, and report failures without implying that completed archive work was rolled back. Every archive path coordinates its target threads from confirmation through mutation. Later overlapping flows wait for the current owner, omit threads it archived successfully or intentionally skipped after a live eligibility re-check, and retry threads it canceled or failed to archive instead of racing or silently dropping the later request. Waiting bulk flows reserve their uncontested sibling threads before awaiting current owners, so later requests cannot make their confirmation scope stale. Completed archives and intentional eligibility skips are published to waiters as they occur, even if a later mutation or navigation throws. Bulk flows also re-check live turn and background-work state after coordination and confirmation, while `Archive all` additionally re-checks settled-partition membership before each mutation. Entries that became active or were un-settled while a flow waited are skipped without aborting the remaining confirmed batch, and the user is warned about the skipped entries.

`SidebarV2.tsx` isolates the fork-owned integration in `SidebarV2SettledLifecycleControls` and `SidebarV2SettledDivider`. Shared lifecycle-button classes keep settle, un-settle, and archive affordances aligned with the upstream row surface tokens while upstream snooze and wake controls retain their own shelf semantics. The slim settled status slot mirrors upstream's `focus-visible` crossfade so its timestamp yields to both lifecycle buttons instead of remaining underneath them. Disabled archive controls retain pointer targeting so clicks cannot fall through to row navigation, and an in-flight `Archive all` remains mounted even after optimistic visibility removes every archivable row. The surrounding row structure, including tooltip wrapping, row sizing, filtering, and decorative environment/provider status semantics, remains upstream-owned. Upstream title-search mode uses separate navigation-only result rows and temporarily replaces the normal lifecycle list; clearing search restores the settled divider and row archive controls. The settled divider remains an interactive list item rather than an aria-hidden separator because it contains both the shelf toggle and `Archive all`.

Primary files:

- `apps/web/src/components/SidebarV2.tsx`
- `apps/web/src/components/Sidebar.logic.ts`
- `apps/web/src/components/Sidebar.logic.test.ts`
- `apps/web/src/hooks/useThreadActions.ts`

## Development Ports

- Web: `5743`
- Server/WebSocket: `13783`
