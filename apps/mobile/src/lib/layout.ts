import { scaledTypographyLineHeight } from "./appearancePreferences";
import { MOBILE_TYPOGRAPHY } from "./typography";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Use available space, not device or orientation labels, to choose the shell.
 *
 * The height floor deliberately keeps every current iPhone in the compact shell
 * when it rotates to landscape, while still allowing iPad and foldable-sized
 * windows to adopt the persistent sidebar as they resize.
 */
export const SPLIT_LAYOUT_MIN_WIDTH = 720;
export const SPLIT_LAYOUT_MIN_HEIGHT = 600;

export const SPLIT_SIDEBAR_MIN_WIDTH = 280;
const SPLIT_SIDEBAR_DEFAULT_MAX_WIDTH = 380;

export const AUXILIARY_PANE_MIN_CONTENT_WIDTH = 960;
export const CHAT_CONTENT_MAX_WIDTH = 960;
// min-h-8 uses the 14px rem configured in metro.config.js.
export const THREAD_WORK_ROW_MIN_HEIGHT = 28;

export function deriveThreadWorkLogSizing(input: {
  readonly baseFontSize: number;
  readonly fontScale: number;
}) {
  const lineHeight = scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.footnote, input.baseFontSize);
  return {
    // Different text metrics can share the same minimum row height.
    textSizeKey: `${input.baseFontSize}:${input.fontScale}`,
    estimatedRowHeight: Math.max(
      THREAD_WORK_ROW_MIN_HEIGHT,
      Math.ceil(lineHeight * input.fontScale),
    ),
    // Native text can exceed its authored line height with accessibility scaling.
    // Leave those rows measured instead of promising LegendList an exact size.
    fixedRowHeight:
      input.fontScale <= 1 && lineHeight <= THREAD_WORK_ROW_MIN_HEIGHT
        ? THREAD_WORK_ROW_MIN_HEIGHT
        : undefined,
  };
}

export const AUXILIARY_PANE_MIN_WIDTH = 260;
export const AUXILIARY_PANE_MAX_WIDTH = 480;
const AUXILIARY_PANE_DEFAULT_MAX_WIDTH = 320;
const FILE_INSPECTOR_MIN_VIEWPORT_WIDTH = 820;
const FILE_INSPECTOR_MIN_MAIN_WIDTH = 560;

export type LayoutVariant = "compact" | "split";

export interface Layout {
  readonly variant: LayoutVariant;
  readonly usesSplitView: boolean;
  readonly listPaneWidth: number | null;
  readonly shellPadding: number;
}

export interface WorkspacePaneLayout {
  readonly primarySidebarVisible: boolean;
  readonly primarySidebarSuppressedByAuxiliary: boolean;
  readonly contentPaneWidth: number;
  readonly supportsAuxiliaryPane: boolean;
  readonly auxiliaryPaneVisible: boolean;
  readonly auxiliaryPaneWidth: number | null;
}

export interface FileInspectorPaneLayout {
  readonly supported: boolean;
  readonly width: number | null;
}

export function deriveThreadFeedInitialContentInset(input: {
  readonly platform: string;
  readonly usesNativeAutomaticInsets: boolean;
  readonly bottomContentInset: number;
}): { readonly bottom: number } | undefined {
  if (input.platform !== "android" || input.usesNativeAutomaticInsets) {
    return undefined;
  }

  return { bottom: Math.max(0, input.bottomContentInset) };
}

export type WorkspaceAuxiliaryPaneRole = "supplementary" | "inspector";

export function deriveLayout(input: { readonly width: number; readonly height: number }): Layout {
  const { width, height } = input;
  const wideEnoughForSplit = width >= SPLIT_LAYOUT_MIN_WIDTH && height >= SPLIT_LAYOUT_MIN_HEIGHT;

  if (!wideEnoughForSplit) {
    return {
      variant: "compact",
      usesSplitView: false,
      listPaneWidth: null,
      shellPadding: 0,
    };
  }

  return {
    variant: "split",
    usesSplitView: true,
    listPaneWidth: clamp(
      Math.round(width * 0.32),
      SPLIT_SIDEBAR_MIN_WIDTH,
      SPLIT_SIDEBAR_DEFAULT_MAX_WIDTH,
    ),
    shellPadding: 0,
  };
}

export function deriveWorkspacePaneLayout(input: {
  readonly layout: Layout;
  readonly viewportWidth: number;
  readonly primarySidebarPreferredVisible: boolean;
  readonly auxiliaryPanePreferredVisible: boolean;
  readonly auxiliaryPaneRole?: WorkspaceAuxiliaryPaneRole;
  readonly auxiliaryPanePreferredWidth?: number;
}): WorkspacePaneLayout {
  const viewportWidth = Math.max(0, input.viewportWidth);
  const auxiliaryPaneRole = input.auxiliaryPaneRole ?? "supplementary";
  const preferredPrimarySidebarVisible =
    input.layout.usesSplitView && input.primarySidebarPreferredVisible;
  const preferredPrimarySidebarWidth = preferredPrimarySidebarVisible
    ? (input.layout.listPaneWidth ?? 0)
    : 0;

  if (auxiliaryPaneRole === "inspector") {
    const fileInspector = deriveFileInspectorPaneLayout({
      layout: input.layout,
      viewportWidth,
      preferredWidth: input.auxiliaryPanePreferredWidth,
      reservedLeadingWidth: preferredPrimarySidebarWidth,
    });
    const auxiliaryPaneVisible = fileInspector.supported && input.auxiliaryPanePreferredVisible;
    const primarySidebarSuppressedByAuxiliary =
      preferredPrimarySidebarVisible &&
      auxiliaryPaneVisible &&
      fileInspector.width !== null &&
      input.layout.listPaneWidth !== null &&
      viewportWidth - input.layout.listPaneWidth - fileInspector.width <
        FILE_INSPECTOR_MIN_MAIN_WIDTH;
    const primarySidebarVisible =
      preferredPrimarySidebarVisible && !primarySidebarSuppressedByAuxiliary;
    const primarySidebarWidth = primarySidebarVisible ? (input.layout.listPaneWidth ?? 0) : 0;

    return {
      primarySidebarVisible,
      primarySidebarSuppressedByAuxiliary,
      contentPaneWidth: Math.max(0, viewportWidth - primarySidebarWidth),
      supportsAuxiliaryPane: fileInspector.supported,
      auxiliaryPaneVisible,
      auxiliaryPaneWidth: fileInspector.width,
    };
  }

  const contentPaneWidth = Math.max(0, viewportWidth - preferredPrimarySidebarWidth);
  const supportsAuxiliaryPane =
    input.layout.usesSplitView && contentPaneWidth >= AUXILIARY_PANE_MIN_CONTENT_WIDTH;
  const auxiliaryPaneVisible = supportsAuxiliaryPane && input.auxiliaryPanePreferredVisible;
  const defaultAuxiliaryPaneWidth = clamp(
    Math.round(contentPaneWidth * 0.28),
    AUXILIARY_PANE_MIN_WIDTH,
    AUXILIARY_PANE_DEFAULT_MAX_WIDTH,
  );

  return {
    primarySidebarVisible: preferredPrimarySidebarVisible,
    primarySidebarSuppressedByAuxiliary: false,
    contentPaneWidth,
    supportsAuxiliaryPane,
    auxiliaryPaneVisible,
    auxiliaryPaneWidth: supportsAuxiliaryPane
      ? constrainAuxiliaryPaneWidth({
          preferredWidth: input.auxiliaryPanePreferredWidth ?? defaultAuxiliaryPaneWidth,
          availableWidth: contentPaneWidth,
        })
      : null,
  };
}

export function deriveFileInspectorPaneLayout(input: {
  readonly layout: Layout;
  readonly viewportWidth: number;
  readonly preferredWidth?: number;
  readonly reservedLeadingWidth?: number;
}): FileInspectorPaneLayout {
  const viewportWidth = Math.max(0, input.viewportWidth);
  const reservedLeadingWidth = Number.isFinite(input.reservedLeadingWidth)
    ? Math.max(0, input.reservedLeadingWidth ?? 0)
    : 0;
  const availableContentWidth = Math.max(0, viewportWidth - reservedLeadingWidth);
  const supported =
    input.layout.usesSplitView && viewportWidth >= FILE_INSPECTOR_MIN_VIEWPORT_WIDTH;

  return {
    supported,
    width: supported
      ? constrainAuxiliaryPaneWidth({
          preferredWidth:
            input.preferredWidth ??
            clamp(
              Math.round(availableContentWidth * 0.28),
              AUXILIARY_PANE_MIN_WIDTH,
              AUXILIARY_PANE_DEFAULT_MAX_WIDTH,
            ),
          availableWidth: availableContentWidth,
        })
      : null,
  };
}

/**
 * Keep an auxiliary pane within native-feeling bounds without squeezing its
 * neighboring content below a usable reading/editor width.
 */
export function constrainAuxiliaryPaneWidth(input: {
  readonly preferredWidth: number;
  readonly availableWidth: number;
}): number {
  const safePreferredWidth = Number.isFinite(input.preferredWidth)
    ? input.preferredWidth
    : AUXILIARY_PANE_MIN_WIDTH;
  const availableWidth = Number.isFinite(input.availableWidth)
    ? Math.max(0, input.availableWidth)
    : 0;
  const maxWidth = Math.max(
    AUXILIARY_PANE_MIN_WIDTH,
    Math.min(AUXILIARY_PANE_MAX_WIDTH, availableWidth - FILE_INSPECTOR_MIN_MAIN_WIDTH),
  );
  return clamp(Math.round(safePreferredWidth), AUXILIARY_PANE_MIN_WIDTH, maxWidth);
}

export function deriveCenteredContentHorizontalPadding(input: {
  readonly viewportWidth: number;
  readonly maxContentWidth: number | null;
  readonly minimumPadding: number;
}): number {
  const viewportWidth = Number.isFinite(input.viewportWidth) ? Math.max(0, input.viewportWidth) : 0;
  const minimumPadding = Number.isFinite(input.minimumPadding)
    ? Math.max(0, input.minimumPadding)
    : 0;

  if (
    input.maxContentWidth === null ||
    !Number.isFinite(input.maxContentWidth) ||
    input.maxContentWidth <= 0
  ) {
    return minimumPadding;
  }

  return minimumPadding + Math.max(0, (viewportWidth - input.maxContentWidth) / 2);
}
