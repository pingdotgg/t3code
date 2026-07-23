# Sidebar V2 Archive Controls

Sidebar V2 preserves archive as a separate lifecycle from settle. Settled rows expose adjacent un-settle and archive buttons on hover or keyboard focus, while root conversation context menus expose archive for both settled and unsettled rows. Archive remains visible but disabled for a running conversation, and nested subagent rows continue to omit root lifecycle actions.

The `Settled` section header includes an `Archive all` action. It applies to the complete settled partition in the current project scope, including rows behind settled-tail pagination, and remains available when the list begins with settled conversations. Individual, selected, and all-settled archive actions honor the shared archive-confirmation setting, use the existing optimistic visibility and archived-snapshot refresh path, preserve already archived results if a later bulk mutation or post-archive navigation fails, remove archived rows from any active selection, and report failures without implying that completed archive work was rolled back.

Primary files:

- `apps/web/src/components/SidebarV2.tsx`
- `apps/web/src/components/Sidebar.logic.ts`
- `apps/web/src/components/Sidebar.logic.test.ts`

## Development Ports

- Web: `5743`
- Server/WebSocket: `13783`
