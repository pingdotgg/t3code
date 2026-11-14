import { useRef } from "react";
import type { SearchBarCommands } from "react-native-screens";

import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useHardwareKeyboardCommand } from "../../keyboard/hardwareKeyboardCommands";
import { getConnectionAwareBrandHeaderOptions } from "./brand-header-options";
import { createWorkspaceListHeaderItems } from "./workspace-list-header-items";
import {
  workspaceListFilterIcon,
  type WorkspaceListHeaderProps,
} from "./WorkspaceListHeader.types";

export function WorkspaceListHeader(props: WorkspaceListHeaderProps) {
  return props.sidebar ? <SidebarColumnHeader {...props} sidebar={props.sidebar} /> : null;
}

function SidebarColumnHeader(
  props: WorkspaceListHeaderProps & {
    readonly sidebar: NonNullable<WorkspaceListHeaderProps["sidebar"]>;
  },
) {
  const { search, sidebar } = props;
  const searchBarRef = useRef<SearchBarCommands>(null);
  useHardwareKeyboardCommand("focusSearch", () => {
    const focus = () => searchBarRef.current?.focus();
    if (!sidebar.visible) {
      sidebar.onRequestVisibility();
      // Focus once the revealed sidebar has slid in.
      setTimeout(focus, 240);
    } else {
      focus();
    }
    return true;
  });
  const items = createWorkspaceListHeaderItems({
    filter: {
      accessibilityLabel: "Filter threads",
      icon: workspaceListFilterIcon(props.filter.customized),
      title: "Thread list options",
      items: props.filter.items,
    },
    onOpenSettings: props.onOpenSettings,
  });

  return (
    <NativeStackScreenOptions
      optionsVersion={[items, sidebar.width]}
      options={{
        ...getConnectionAwareBrandHeaderOptions({
          headerWidth: sidebar.width,
          trailingItemCount: items.length,
          onOpenEnvironments: props.onOpenEnvironments,
          fallbackTitleStyle: { fontSize: 18, fontWeight: "800" },
        }),
        headerSearchBarOptions: {
          ref: searchBarRef,
          autoCapitalize: "none",
          hideNavigationBar: false,
          hideWhenScrolling: false,
          obscureBackground: false,
          placeholder: search.placeholder,
          placement: "stacked",
          onCancelButtonPress: () => search.onChangeText(""),
          onChangeText: (event) => search.onChangeText(event.nativeEvent.text),
        },
        unstable_headerRightItems: () => items,
      }}
    />
  );
}
