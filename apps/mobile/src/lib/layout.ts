import { scaledTypographyLineHeight } from "./appearancePreferences";
import { MOBILE_TYPOGRAPHY } from "./typography";
import type { NativeLayoutMetrics } from "./reserved-regions";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const MEDIUM_LAYOUT_MIN_WIDTH = 600;
const EXPANDED_LAYOUT_MIN_WIDTH = 720;
const SPLIT_LAYOUT_MIN_HEIGHT = 600;

const SPLIT_SIDEBAR_MIN_WIDTH = 280;
const SPLIT_SIDEBAR_DEFAULT_MAX_WIDTH = 380;

export const CHAT_CONTENT_MAX_WIDTH = 960;
// Limit Android reading width for wide foldables and keyboard-open split views.
export const ANDROID_READING_MAX_WIDTH = 640;
// min-h-8 uses the 14px rem configured in metro.config.js.
export const THREAD_WORK_ROW_MIN_HEIGHT = 28;

export function deriveThreadArrangementSizing(input: {
  readonly baseFontSize: number;
  readonly fontScale: number;
}) {
  const bodyLineHeight = scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.body, input.baseFontSize);
  const headerLineHeight = scaledTypographyLineHeight(
    MOBILE_TYPOGRAPHY.footnote,
    input.baseFontSize,
  );
  return {
    rowHeight: Math.max(56, Math.ceil(2 * bodyLineHeight * input.fontScale) + 10),
    headerHeight: Math.max(48, Math.ceil(headerLineHeight * input.fontScale) + 24),
  };
}

export function deriveThreadWorkLogSizing(input: {
  readonly baseFontSize: number;
  readonly fontScale: number;
}) {
  const lineHeight = scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.footnote, input.baseFontSize);
  return {
    textSizeKey: `${input.baseFontSize}:${input.fontScale}`,
    estimatedRowHeight: Math.max(
      THREAD_WORK_ROW_MIN_HEIGHT,
      Math.ceil(lineHeight * input.fontScale),
    ),
    // Accessibility scaling can exceed authored line heights; leave those rows measured.
    fixedRowHeight:
      input.fontScale <= 1 && lineHeight <= THREAD_WORK_ROW_MIN_HEIGHT
        ? THREAD_WORK_ROW_MIN_HEIGHT
        : undefined,
  };
}

const AUXILIARY_PANE_MIN_WIDTH = 260;
const AUXILIARY_PANE_MAX_WIDTH = 480;
const AUXILIARY_PANE_DEFAULT_MAX_WIDTH = 320;
const FILE_INSPECTOR_MIN_VIEWPORT_WIDTH = 820;
const FILE_INSPECTOR_MIN_MAIN_WIDTH = 560;

/**
 * The window's width class. Compact: the sidebar is the root and pages push over it. Medium: the
 * sidebar floats over the content. Expanded: the sidebar sits beside the content.
 */
export type LayoutVariant = "compact" | "medium" | "expanded";

export interface Layout {
  readonly variant: LayoutVariant;
  /** Medium or expanded: pages replace the content beside the sidebar instead of pushing. */
  readonly usesSplitView: boolean;
  readonly listPaneWidth: number | null;
  readonly listPaneGap?: number;
  readonly shellPadding: number;
}

export interface WorkspacePaneLayout {
  readonly primarySidebarVisible: boolean;
  /** Whether the sidebar shows once a collapsed split expands; independent of the current width. */
  readonly primarySidebarWhenExpanded: boolean;
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

export function deriveLayout(input: {
  readonly width: number;
  readonly height: number;
  readonly nativeMetrics?: NativeLayoutMetrics | null;
  readonly nativeWorkspace?: boolean;
}): Layout {
  const { width, height } = input;
  const metrics = input.nativeMetrics;
  const usableWidth = width - (metrics?.safeArea.left ?? 0) - (metrics?.safeArea.right ?? 0);
  // UIKit retains split columns below the generic tablet breakpoint. Native
  // columns follow its size class while reserving room for both column minimums.
  // Unfolded in portrait, the inner display reports neither a side bar nor a
  // fold, only its hinge.
  const hasDuoGeometry =
    metrics &&
    (metrics.hasHinge === true ||
      metrics.verticalBarEdge !== "none" ||
      metrics.reservedRegions.some((region) => region.kind === "division"));
  const variant: LayoutVariant =
    metrics && (input.nativeWorkspace || hasDuoGeometry)
      ? metrics.horizontalSizeClass === "regular" &&
        usableWidth >= SPLIT_SIDEBAR_MIN_WIDTH + 320 &&
        (input.nativeWorkspace || height >= 400)
        ? // The native split floats its sidebar over an unfolded portrait Duo.
          input.nativeWorkspace === true && metrics.hasHinge === true && width < height
          ? "medium"
          : "expanded"
        : "compact"
      : height < SPLIT_LAYOUT_MIN_HEIGHT || width < MEDIUM_LAYOUT_MIN_WIDTH
        ? "compact"
        : width >= EXPANDED_LAYOUT_MIN_WIDTH
          ? "expanded"
          : // Only the Android shell floats a sidebar over a page; iOS keeps its phone stack.
            metrics
            ? "compact"
            : "medium";

  if (variant === "compact") {
    return {
      variant,
      usesSplitView: false,
      listPaneWidth: null,
      shellPadding: 0,
    };
  }

  const division = metrics?.reservedRegions.find(
    (region) =>
      region.kind === "division" &&
      region.height >= height / 2 &&
      region.x - metrics.safeArea.left >= SPLIT_SIDEBAR_MIN_WIDTH &&
      width - region.x - region.width - metrics.safeArea.right >= 320,
  );
  return {
    variant,
    usesSplitView: true,
    listPaneWidth:
      division?.x ??
      clamp(Math.round(width * 0.32), SPLIT_SIDEBAR_MIN_WIDTH, SPLIT_SIDEBAR_DEFAULT_MAX_WIDTH),
    ...(division ? { listPaneGap: division.width } : {}),
    shellPadding: 0,
  };
}

export interface VerticalHinge {
  readonly x: number;
  readonly width: number;
}

/**
 * Moves the list/detail split onto a book-posture hinge so neither pane straddles the crease.
 * `leadingWidth` is chrome left of the list pane, such as the Android navigation rail.
 */
export function alignListPaneToHinge(input: {
  readonly layout: Layout;
  readonly hinge: VerticalHinge | null;
  readonly viewportWidth: number;
  readonly leadingWidth: number;
}): Layout {
  const { layout, hinge } = input;
  if (!hinge || !layout.usesSplitView) return layout;
  const listPaneWidth = hinge.x - input.leadingWidth;
  if (
    listPaneWidth < SPLIT_SIDEBAR_MIN_WIDTH ||
    input.viewportWidth - hinge.x - hinge.width < 320
  ) {
    return layout;
  }
  return { ...layout, listPaneWidth, listPaneGap: hinge.width };
}

/**
 * Whether the workspace root must keep the primary sidebar open. Native split
 * columns keep a sidebar toggle in the empty detail header, so only they may
 * collapse it there. Compact layouts stay pinned so a reveal request (such as
 * focusing search) cannot flip the saved preference for a later split view.
 */
/** Home's list, or the Settings list in its place, with no detail selected. */
export function isWorkspaceListPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/settings";
}

export function isPrimarySidebarPinned(input: {
  readonly pathname: string;
  readonly nativeWorkspace: boolean;
  readonly usesSplitView: boolean;
}): boolean {
  return isWorkspaceListPath(input.pathname) && !(input.nativeWorkspace && input.usesSplitView);
}

export function deriveWorkspacePaneLayout(input: {
  readonly layout: Layout;
  readonly viewportWidth: number;
  readonly nativeWorkspace?: boolean;
  /** Whether the sidebar floats over the content rather than taking its room; medium by default. */
  readonly primarySidebarFloats?: boolean;
  readonly primarySidebarPreferredVisible: boolean;
  readonly auxiliaryPanePreferredVisible: boolean;
  readonly auxiliaryPanePreferredWidth?: number;
}): WorkspacePaneLayout {
  const viewportWidth = Math.max(0, input.viewportWidth);
  const floats = input.primarySidebarFloats ?? input.layout.variant === "medium";
  const preferredPrimarySidebarVisible =
    input.layout.usesSplitView && input.primarySidebarPreferredVisible;
  const preferredPrimarySidebarWidth =
    preferredPrimarySidebarVisible && !floats
      ? (input.layout.listPaneWidth ?? 0) + (input.layout.listPaneGap ?? 0)
      : 0;
  const fileInspector = deriveFileInspectorPaneLayout({
    layout: input.layout,
    viewportWidth,
    preferredWidth: input.auxiliaryPanePreferredWidth,
    reservedLeadingWidth: preferredPrimarySidebarWidth,
  });
  const auxiliaryPaneVisible = fileInspector.supported && input.auxiliaryPanePreferredVisible;
  const primarySidebarSuppressedByAuxiliary =
    !input.nativeWorkspace &&
    preferredPrimarySidebarVisible &&
    !floats &&
    auxiliaryPaneVisible &&
    fileInspector.width !== null &&
    input.layout.listPaneWidth !== null &&
    viewportWidth -
      input.layout.listPaneWidth -
      (input.layout.listPaneGap ?? 0) -
      fileInspector.width <
      FILE_INSPECTOR_MIN_MAIN_WIDTH;
  const primarySidebarVisible =
    preferredPrimarySidebarVisible && !primarySidebarSuppressedByAuxiliary;
  const primarySidebarWidth = primarySidebarVisible ? preferredPrimarySidebarWidth : 0;

  return {
    primarySidebarVisible,
    primarySidebarWhenExpanded: input.primarySidebarPreferredVisible,
    primarySidebarSuppressedByAuxiliary,
    contentPaneWidth: Math.max(0, viewportWidth - primarySidebarWidth),
    supportsAuxiliaryPane: fileInspector.supported,
    auxiliaryPaneVisible,
    auxiliaryPaneWidth: fileInspector.width,
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
