import type { WorkspaceTab } from "./workspace/workspace-tabs-state";
import { createContext, use } from "react";
import type { InspectorContent } from "./inspector-panes";
import type { WorkspaceDetail, WorkspaceDetailSheet } from "./workspace/workspace-detail-selection";
import {
  deriveFileInspectorPaneLayout,
  deriveLayout,
  deriveWorkspacePaneLayout,
  type FileInspectorPaneLayout,
  type Layout,
  type WorkspacePaneLayout,
} from "../../lib/layout";

/** The workspace's actions; their identities never change. */
export interface AdaptiveWorkspaceActions {
  readonly startNewTask: () => void;
  /** Use `useSelectWorkspaceDetail`, which also works outside the layout. */
  readonly selectDetail?: (detail: WorkspaceDetail, sheet?: WorkspaceDetailSheet) => void;
  readonly registerWorkspaceInspector: (
    content: InspectorContent,
    routeKey: string | undefined,
    revealKey?: string,
  ) => () => void;
  readonly setPrimarySidebarSearchQuery: (query: string) => void;
  /** Opens the inspector: its column where the window has one, otherwise a sheet. */
  readonly showInspector: () => void;
  readonly toggleAuxiliaryPane: () => void;
  readonly togglePrimarySidebar: () => void;
  /** Shows the sidebar, setting aside the keyboard or an inspector that took its room. */
  readonly revealPrimarySidebar: () => void;
  readonly setPrimarySidebarVisible: (visible: boolean) => void;
  /** Opens a workspace tab with its list and, with columns, the page it last showed. */
  readonly openWorkspaceTab: (
    tab: WorkspaceTab | "settings",
    options?: { readonly columns?: boolean },
  ) => void;
  readonly setAuxiliaryPaneWidth: (width: number) => void;
  readonly setNativeInspectorWidth: (width: number) => void;
  /** The thread composer reports its focus so the layout can make room for typing. */
  readonly setComposerEditing: (editing: boolean) => void;
}

/** Changes only with the window (size, fold, hinge), never with a pane toggle or the keyboard. */
interface AdaptiveWorkspaceLayoutValue extends AdaptiveWorkspaceActions {
  readonly layout: Layout;
  readonly nativeInspectorWidth: number;
  /** Android split: the width a workspace page (Usage) opens at; null without columns. */
  readonly workspacePageWidth?: number | null;
}

/** Changes as panes toggle and the keyboard comes and goes; read it only where that shows. */
interface WorkspacePaneStateValue {
  readonly panes: WorkspacePaneLayout;
  readonly fileInspector: FileInspectorPaneLayout;
  readonly primarySidebarSearchQuery: string;
  /**
   * Whether the content pane offers a sidebar button: false without columns, on a list that keeps
   * its sidebar, and on a workspace page (Android Settings, Usage) that covers it.
   */
  readonly sidebarToggleable: boolean;
  /**
   * Android split view while the thread composer has the soft keyboard: the
   * sidebar and rail step aside and the thread header drops to one line.
   */
  readonly composerKeyboardActive: boolean;
  /**
   * Whether the sidebar shows in each orientation, where it floats over the content in portrait
   * (the unfolded Duo). The native split switches between them as a rotation starts.
   */
  readonly sidebarByOrientation: { readonly landscape: boolean; readonly portrait: boolean } | null;
  /** Android split: the composer's keyboard slides the sidebar, from focus until it lets go. */
  readonly keyboardHoldsSidebar?: boolean;
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
export const AdaptiveWorkspaceContext = createContext<AdaptiveWorkspaceLayoutValue>({
  layout: compactLayout,
  startNewTask: () => undefined,
  registerWorkspaceInspector: () => () => undefined,
  setPrimarySidebarSearchQuery: () => undefined,
  showInspector: () => undefined,
  toggleAuxiliaryPane: () => undefined,
  togglePrimarySidebar: () => undefined,
  revealPrimarySidebar: () => undefined,
  setPrimarySidebarVisible: () => undefined,
  openWorkspaceTab: () => undefined,
  setAuxiliaryPaneWidth: () => undefined,
  nativeInspectorWidth: 0,
  setNativeInspectorWidth: () => undefined,
  setComposerEditing: () => undefined,
});
export const WorkspacePaneStateContext = createContext<WorkspacePaneStateValue>({
  panes: compactPanes,
  fileInspector: compactFileInspector,
  primarySidebarSearchQuery: "",
  sidebarToggleable: false,
  composerKeyboardActive: false,
  sidebarByOrientation: null,
});

/** The window's layout and the workspace's actions. Toggling a pane doesn't re-render readers. */
export function useAdaptiveWorkspaceLayout(): AdaptiveWorkspaceLayoutValue {
  return use(AdaptiveWorkspaceContext);
}

/** Which panes show, and the keyboard's hold on them. Re-renders on every pane toggle. */
export function useWorkspacePaneState(): WorkspacePaneStateValue {
  return use(WorkspacePaneStateContext);
}
