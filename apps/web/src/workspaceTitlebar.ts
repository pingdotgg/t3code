// Match the sidebar gap during a drag, before pointer-up commits its visibility.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]:not([data-sidebar-drag-state=expanded])_&]:ps-[var(--workspace-titlebar-content-start)] [[data-sidebar-drag-state=collapsed]_&]:ps-[var(--workspace-titlebar-content-start)] max-md:[[data-sidebar-state=expanded]_&]:ps-[var(--workspace-titlebar-content-start)] [[data-sidebar-drag-state]_&]:transition-none!";
