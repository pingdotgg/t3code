import type { WorkspaceTab } from "../workspace/workspace-tabs-state";
import { createContext, use, type ReactNode } from "react";
import type {
  WorkspaceDetail,
  WorkspaceDetailSheet,
} from "../workspace/workspace-detail-selection";
import {
  deriveFileInspectorPaneLayout,
  deriveLayout,
  deriveWorkspacePaneLayout,
  type FileInspectorPaneLayout,
  type Layout,
  type WorkspaceAuxiliaryPaneRole,
  type WorkspacePaneLayout,
} from "../../lib/layout";

interface AdaptiveWorkspaceContextValue {
  readonly layout: Layout;
  readonly panes: WorkspacePaneLayout;
  readonly fileInspector: FileInspectorPaneLayout;
  readonly primarySidebarSearchQuery: string;
  readonly startNewTask: () => void;
  readonly deferThreadSelectionUntil: (operation: Promise<unknown>) => void;
  /** Use `useSelectWorkspaceDetail`, which also works outside the layout. */
  readonly selectDetail?: (detail: WorkspaceDetail, sheet?: WorkspaceDetailSheet) => void;
  readonly activateAuxiliaryPaneRole: (role: WorkspaceAuxiliaryPaneRole) => () => void;
  readonly registerWorkspaceInspector: (render: () => ReactNode) => () => void;
  readonly setPrimarySidebarSearchQuery: (query: string) => void;
  readonly showAuxiliaryPane: (role: WorkspaceAuxiliaryPaneRole) => void;
  readonly toggleAuxiliaryPane: () => void;
  readonly togglePrimarySidebar: () => void;
  readonly setPrimarySidebarVisible: (visible: boolean) => void;
  /** Opens a workspace tab with its list and, with columns, the page it last showed. */
  readonly openWorkspaceTab: (
    tab: WorkspaceTab | "settings",
    options?: { readonly columns?: boolean },
  ) => void;
  readonly setAuxiliaryPaneWidth: (width: number) => void;
  /**
   * Android split view while the thread composer has the soft keyboard: the
   * sidebar and rail step aside and the thread header drops to one line.
   */
  readonly composerKeyboardActive: boolean;
  /** The thread composer reports its focus so the layout can make room for typing. */
  readonly setComposerEditing: (editing: boolean) => void;
}

const compactLayout = deriveLayout({ width: 0, height: 0 });
const compactPanes = deriveWorkspacePaneLayout({
  layout: compactLayout,
  viewportWidth: 0,
  primarySidebarPreferredVisible: true,
  auxiliaryPanePreferredVisible: true,
});
const compactFileInspector = deriveFileInspectorPaneLayout({
  layout: compactLayout,
  viewportWidth: 0,
});
export const AdaptiveWorkspaceContext = createContext<AdaptiveWorkspaceContextValue>({
  layout: compactLayout,
  panes: compactPanes,
  fileInspector: compactFileInspector,
  primarySidebarSearchQuery: "",
  startNewTask: () => undefined,
  deferThreadSelectionUntil: () => undefined,
  activateAuxiliaryPaneRole: () => () => undefined,
  registerWorkspaceInspector: () => () => undefined,
  setPrimarySidebarSearchQuery: () => undefined,
  showAuxiliaryPane: () => undefined,
  toggleAuxiliaryPane: () => undefined,
  togglePrimarySidebar: () => undefined,
  setPrimarySidebarVisible: () => undefined,
  openWorkspaceTab: () => undefined,
  setAuxiliaryPaneWidth: () => undefined,
  composerKeyboardActive: false,
  setComposerEditing: () => undefined,
});

export function useAdaptiveWorkspaceLayout(): AdaptiveWorkspaceContextValue {
  return use(AdaptiveWorkspaceContext);
}
