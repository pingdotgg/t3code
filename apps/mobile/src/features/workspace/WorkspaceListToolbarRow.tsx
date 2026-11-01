import type { ReactNode } from "react";
import { View } from "react-native";
import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";

export interface WorkspaceListToolbarSearch {
  readonly searching: boolean;
  readonly field: ReactNode;
  readonly onClose: () => void;
  readonly onOpen: () => void;
  readonly accessibilityLabel: string;
}

export function WorkspaceBrandTitle(props: {
  readonly accessibilityLabel: string;
  readonly onOpenEnvironments: () => void;
}) {
  return (
    <WorkspaceConnectionTitle
      grow
      onPress={props.onOpenEnvironments}
      brand={
        <CompactBrandTitle
          allowFontScaling={false}
          accessibilityLabel={props.accessibilityLabel}
          fit
        />
      }
    />
  );
}

/**
 * The Android header row above each workspace tab. Every tab draws this same row, so
 * switching tabs leaves the title and buttons where they were. It is plain React Native rather
 * than the Compose app bar: a hidden tab lays out at zero size, and Compose-hosted content takes
 * several frames to measure again when the tab comes back.
 */
export function WorkspaceListToolbarRow(props: {
  readonly title: ReactNode;
  readonly search?: WorkspaceListToolbarSearch;
  /** Stays trailing while searching, so it never moves and still narrows the results. */
  readonly filter: ReactNode;
}) {
  const { height } = useToolbarLayout();
  const { search } = props;
  return (
    <View className="flex-row items-center gap-1" style={{ minHeight: height }}>
      {search?.searching ? (
        <>
          <AndroidHeaderIconButton
            accessibilityLabel="Close search"
            icon="arrow.left"
            onPress={search.onClose}
          />
          {search.field}
          {props.filter}
        </>
      ) : (
        <>
          <View className="min-w-0 flex-1 pl-4">{props.title}</View>
          {search ? (
            <AndroidHeaderIconButton
              accessibilityLabel={search.accessibilityLabel}
              icon="magnifyingglass"
              onPress={search.onOpen}
            />
          ) : null}
          {props.filter}
        </>
      )}
    </View>
  );
}
