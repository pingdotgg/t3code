import type { ReactNode } from "react";
import { View } from "react-native";
import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";

/**
 * The Android header row above each workspace tab's list. Both tabs draw this same row, so
 * switching tabs leaves the title and buttons where they were. It is plain React Native rather
 * than the Compose app bar: a hidden tab lays out at zero size, and Compose-hosted content takes
 * several frames to measure again when the tab comes back.
 */
export function WorkspaceListToolbarRow(props: {
  readonly searching: boolean;
  readonly searchField: ReactNode;
  readonly onCloseSearch: () => void;
  readonly onOpenSearch: () => void;
  readonly searchAccessibilityLabel: string;
  readonly titleAccessibilityLabel: string;
  readonly onOpenEnvironments: () => void;
  /** Stays trailing while searching, so it never moves and still narrows the results. */
  readonly filter: ReactNode;
}) {
  const { height } = useToolbarLayout();
  return (
    <View className="flex-row items-center gap-1" style={{ minHeight: height }}>
      {props.searching ? (
        <>
          <AndroidHeaderIconButton
            accessibilityLabel="Close search"
            icon="arrow.left"
            onPress={props.onCloseSearch}
          />
          {props.searchField}
          {props.filter}
        </>
      ) : (
        <>
          <View className="min-w-0 flex-1 pl-4">
            <WorkspaceConnectionTitle
              grow
              onPress={props.onOpenEnvironments}
              brand={
                <CompactBrandTitle
                  allowFontScaling={false}
                  accessibilityLabel={props.titleAccessibilityLabel}
                  fit
                />
              }
            />
          </View>
          <AndroidHeaderIconButton
            accessibilityLabel={props.searchAccessibilityLabel}
            icon="magnifyingglass"
            onPress={props.onOpenSearch}
          />
          {props.filter}
        </>
      )}
    </View>
  );
}
