import { Platform } from "react-native";

import { GLASS_HEADER_OPTIONS, type AppScreenOptions } from "../../native/glass-header-options";
import { formSheetDetents } from "../../native/sheet-surface";

/**
 * Route presets for the root stack. A route says what it is (a page, a sheet, a modal); the
 * preset owns how each platform presents it, so screens never set presentation options.
 *
 * Android never shows the native stack header: every screen draws its bar in-tree with AppBar or
 * SheetHeader, and the Android navigators hide the native one from the first frame.
 */

type HeaderStyle = "glass" | "solid" | "none";

const SOLID_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: false,
};

function headerOptions(header: HeaderStyle, itemStyle: "editor" | "standard"): AppScreenOptions {
  if (header === "none") return { headerShown: false };
  if (header === "glass") {
    // The editor style needs liquid glass, which GLASS_HEADER_OPTIONS already gates it on.
    return itemStyle === "editor"
      ? GLASS_HEADER_OPTIONS
      : { ...GLASS_HEADER_OPTIONS, unstable_navigationItemStyle: undefined };
  }
  return {
    ...SOLID_HEADER_OPTIONS,
    unstable_navigationItemStyle:
      itemStyle === "editor" && Platform.OS === "ios" ? "editor" : undefined,
  };
}

export interface PageRouteOptions {
  readonly title?: string;
  /** Glass bars let content scroll under them. Defaults to glass. */
  readonly header?: HeaderStyle;
  /** iOS 26 groups a page's bar items like an editor; settings pages use the standard look. */
  readonly itemStyle?: "editor" | "standard";
  /**
   * How the Duo minimizes the bar while scrolling. "never" for lists that stutter against the
   * default on hardware; "onScrollUp" for conversations read backwards, like Messages.
   */
  readonly duoMinimize?: "never" | "onScrollUp";
  /** The page is the root of its column, so it never shows Back. */
  readonly root?: boolean;
}

/** A page in the workspace: pushed on compact windows, a column page on wide ones. */
export function pageRoute(options: PageRouteOptions = {}): AppScreenOptions {
  return {
    ...headerOptions(options.header ?? "glass", options.itemStyle ?? "editor"),
    ...(options.title === undefined ? undefined : { title: options.title }),
    ...(options.duoMinimize
      ? { unstable_headerMinimizationBehavior: options.duoMinimize }
      : undefined),
    ...(options.root ? { headerBackVisible: false } : undefined),
  };
}

export interface SheetRouteOptions {
  readonly title?: string;
  /** Defaults to glass. "none" when the sheet draws no bar at all. */
  readonly header?: HeaderStyle;
  /** The initial detent, or "full" for a sheet that always covers the window. */
  readonly detent: number | "full";
  /** The largest detent. Defaults to the full window on iOS, where the Duo needs it. */
  readonly maxDetent?: number;
  /** Android's expanded detent when `maxDetent` is unset. */
  readonly androidMaxDetent?: number;
  /** Android sizes the sheet to its content instead of using detents. */
  readonly androidFit?: boolean;
  /**
   * Where an Android formSheet can't host the screen: "card" pushes it, "fullScreen" presents it
   * full screen (Android formSheets can't host a keyboard-driven composer).
   */
  readonly android?: "sheet" | "card" | "fullScreen";
  /** The sheet spans the Duo's rail, and its content insets itself. */
  readonly spansRail?: boolean;
  readonly itemStyle?: "editor" | "standard";
  readonly duoMinimize?: "never" | "onScrollUp";
}

function sheetDetents(options: SheetRouteOptions): number[] {
  if (options.detent === "full") return [1];
  if (options.maxDetent !== undefined) return [options.detent, options.maxDetent];
  return formSheetDetents(options.detent, options.androidMaxDetent);
}

/** A sheet over the workspace: a formSheet with a grabber that closes, never goes back. */
export function sheetRoute(options: SheetRouteOptions): AppScreenOptions {
  const header = headerOptions(options.header ?? "glass", options.itemStyle ?? "standard");
  const shared = {
    ...header,
    ...(options.title === undefined ? undefined : { title: options.title }),
    ...(options.duoMinimize
      ? { unstable_headerMinimizationBehavior: options.duoMinimize }
      : undefined),
    headerBackVisible: false,
    gestureEnabled: true,
  } satisfies AppScreenOptions;
  if (Platform.OS === "android" && options.android === "card") {
    return { ...shared, presentation: "card" };
  }
  if (Platform.OS === "android" && options.android === "fullScreen") {
    return { ...shared, presentation: "fullScreenModal" };
  }
  return {
    ...shared,
    presentation: "formSheet",
    sheetPrefersHorizontalBars: true,
    sheetGrabberVisible: true,
    sheetAllowedDetents:
      Platform.OS === "android" && options.androidFit ? "fitToContents" : sheetDetents(options),
    ...(Platform.OS === "android" ? { sheetCornerRadius: 28 } : undefined),
    ...(options.spansRail ? { nativeContentInsetHorizontally: false } : undefined),
  } as AppScreenOptions;
}

export interface ModalRouteOptions {
  readonly title?: string;
  /** Defaults to "none": the screen draws its own SheetHeader or has no bar. */
  readonly header?: HeaderStyle;
  readonly itemStyle?: "editor" | "standard";
  readonly duoMinimize?: "never" | "onScrollUp";
}

/** A full-screen modal over the workspace with a close button, not a back button. */
export function modalRoute(options: ModalRouteOptions = {}): AppScreenOptions {
  return {
    ...headerOptions(options.header ?? "none", options.itemStyle ?? "standard"),
    ...(options.title === undefined ? undefined : { title: options.title }),
    ...(options.duoMinimize
      ? { unstable_headerMinimizationBehavior: options.duoMinimize }
      : undefined),
    headerBackVisible: false,
    presentation: "fullScreenModal",
  };
}
