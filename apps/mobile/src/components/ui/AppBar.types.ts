import type { ReactNode } from "react";
import type { ColorValue } from "react-native";
import type { AppSymbolName } from "./AppSymbol";

export interface AppBarAction {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly selected?: boolean;
  readonly tintColor?: ColorValue;
  /** Android overflow menu: the row's second line. */
  readonly subtitle?: string;
  readonly destructive?: boolean;
  /** Android: always in the overflow menu, never a toolbar button. */
  readonly overflowOnly?: boolean;
  /** iOS: false shares one glass capsule with neighbouring items. Defaults to true. */
  readonly separateBackground?: boolean;
}

export type AppBarMenuItem =
  | {
      readonly id: string;
      readonly title: string;
      readonly icon?: string;
      /** Android: tints the icon, such as a label's color dot. */
      readonly iconColor?: ColorValue;
      readonly subtitle?: string;
      readonly disabled?: boolean;
      readonly selected?: boolean;
      readonly destructive?: boolean;
      readonly onPress: () => void;
    }
  | {
      readonly id: string;
      readonly title?: string;
      readonly icon?: string;
      readonly inline?: boolean;
      readonly items: ReadonlyArray<AppBarMenuItem>;
    };

export interface AppBarMenu {
  readonly title: string;
  readonly icon: AppSymbolName;
  readonly status?: string;
  readonly separateBackground?: boolean;
  readonly items: ReadonlyArray<AppBarMenuItem>;
}

export interface AppBarConfirm {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  /**
   * When true, shows `label` in the toolbar. Sheets keep the checkmark-only control by
   * leaving this unset. With `icon` and no label, both platforms use an icon button.
   */
  readonly showLabel?: boolean;
  /** Custom glyph; without `showLabel`, replaces the default checkmark (iOS) / text (Android). */
  readonly icon?: AppSymbolName;
  /** Defaults to `label`. Use when the visible control is icon-only or shortened. */
  readonly accessibilityLabel?: string;
}

export interface AppBarSearch {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly placeholder: string;
  /** Defaults to the placeholder. */
  readonly accessibilityLabel?: string;
  readonly mode?: "inline" | "collapsible";
  readonly compactToolbar?: boolean;
  readonly compactPlaceholder?: string;
  readonly closeAccessibilityLabel?: string;
  readonly clearAccessibilityLabel?: string;
  /** Controlled open state. The owner then also handles back and the keyboard shortcut. */
  readonly active?: boolean;
  readonly onOpen?: () => void;
  readonly onClose?: () => void;
}

export interface AppBarProps {
  readonly title: string;
  /** Android: replaces the title text, such as the brand title. iOS ignores it. */
  readonly titleContent?: ReactNode;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AppBarAction>;
  /** Pull-to-refresh is the gesture on both platforms; Android also lists this in the overflow menu. */
  readonly refresh?: Pick<AppBarAction, "accessibilityLabel" | "disabled" | "onPress">;
  readonly menus?: ReadonlyArray<AppBarMenu>;
  readonly search?: AppBarSearch;
  readonly onBack?: () => void;
  /** Back runs `onBack` and swipe-back is off, so a `usePreventRemove` guard sees it first. */
  readonly guardBack?: boolean;
  /**
   * Back for a page whose parent is the workspace list. Hidden in split view, where the list is
   * beside the page; shown even when the page opened with nothing beneath it.
   */
  readonly onBackToList?: () => void;
  /**
   * iOS: a labelled compose button beside the sidebar button in split view. The Duo's column bar
   * and Android's sidebar compose on their own, so they ignore it.
   */
  readonly onCompose?: () => void;
  /**
   * The bar of a sheet or modal: a close button leads the bar in place of Back and the sidebar
   * button, on both platforms.
   */
  readonly onClose?: () => void;
  /** Defaults to "Close". */
  readonly closeAccessibilityLabel?: string;
  /** A sheet's confirm button, last in the bar. */
  readonly confirm?: AppBarConfirm;
  /** Android: replaces the sidebar button at the start of the bar. */
  readonly leading?: ReactNode;
  /**
   * Workspace shell only: a second bar inside a route whose own bar is drawn elsewhere, such as
   * a workspace tab pane. Leaves route options alone; iOS draws nothing. Screens never set it.
   */
  readonly embedded?: boolean;
  /** A bar at the top of a sheet that is not a route (routed sheets are detected). */
  readonly sheet?: boolean;
  readonly backInSplitView?: {
    readonly accessibilityLabel: string;
    readonly icon: string;
    readonly separateBackground?: boolean;
    readonly onPress?: () => void;
  };
  readonly hideBottomBorder?: boolean;
  /** Android: one title row with the subtitle inline. iOS ignores it. */
  readonly compact?: boolean;
  readonly trailing?: ReactNode;
  readonly matchSearchSurface?: boolean;
  readonly optionsVersion?: unknown;
}
