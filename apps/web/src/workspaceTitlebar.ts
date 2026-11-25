// Match the sidebar gap during a drag, before pointer-up commits its visibility.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]:not([data-sidebar-drag-state=expanded])_&]:pl-[var(--workspace-titlebar-content-left)] [[data-sidebar-drag-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)] [[data-sidebar-drag-state]_&]:transition-none!";
