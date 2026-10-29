import type { ReactNode } from "react";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";
import { WorkspaceAppBar, type WorkspaceAppBarProps } from "./WorkspaceAppBar";

/** The Android header of a workspace list tab: the brand title, search, and a filter. */
export function WorkspaceListAppBar(props: {
  readonly searching: boolean;
  readonly searchField: ReactNode;
  readonly onCloseSearch: () => void;
  readonly onOpenSearch: () => void;
  readonly searchAccessibilityLabel: string;
  readonly titleAccessibilityLabel: string;
  readonly onOpenEnvironments: () => void;
  readonly filter: WorkspaceAppBarProps["filter"];
}) {
  return (
    <WorkspaceAppBar
      title="T3 Code"
      titleContent={
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
      }
      search={{
        accessibilityLabel: props.searchAccessibilityLabel,
        active: props.searching,
        field: props.searchField,
        onOpen: props.onOpenSearch,
        onClose: props.onCloseSearch,
      }}
      filter={props.filter}
    />
  );
}
