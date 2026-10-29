import type { ReactNode } from "react";
import type { ColorValue } from "react-native";
import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
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
}

export type AppBarMenuItem =
  | {
      readonly id: string;
      readonly title: string;
      readonly icon?: string;
      readonly subtitle?: string;
      readonly disabled?: boolean;
      readonly selected?: boolean;
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
  readonly onRefresh?: () => void;
  readonly refreshAccessibilityLabel?: string;
  readonly refreshInToolbar?: boolean;
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
  readonly menus?: ReadonlyArray<AppBarMenu>;
  readonly search?: AppBarSearch;
  readonly onBack?: () => void;
  readonly sidebar?: boolean;
  /** Android: replaces the sidebar button at the start of the bar. */
  readonly leading?: ReactNode;
  /** Leaves route options to the screen: in-screen bars, and screens that set their own. iOS draws nothing. */
  readonly embedded?: boolean;
  /** An embedded bar at the top of a sheet. */
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
  readonly options?: AppNativeStackNavigationOptions;
  readonly optionsVersion?: unknown;
}
