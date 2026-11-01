import { useRef, useState, type ReactNode } from "react";
import { Keyboard, type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { AppBarSearch } from "../../components/ui/AppBar.types";
import { SearchField } from "../../components/ui/SearchField";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { useHardwareBack } from "../../lib/backHandler";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { WorkspaceListToolbarRow } from "./WorkspaceListToolbarRow";

/** Android header for a titled workspace tab, laid out like the Threads and Pulls headers. */
export function WorkspaceTabToolbar(props: {
  readonly title: string;
  readonly search?: AppBarSearch;
  readonly trailing?: ReactNode;
}) {
  const { search } = props;
  const { paddingTop, paddingBottom } = useToolbarLayout();
  const inputRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = search !== undefined && (searchOpen || search.value.length > 0);
  const closeSearch = () => {
    search?.onChangeText("");
    setSearchOpen(false);
    Keyboard.dismiss();
  };
  useHardwareBack(searching, () => {
    closeSearch();
    return true;
  });

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false, title: props.title }} />
      <View className="bg-header px-2" style={{ paddingTop, paddingBottom }}>
        <WorkspaceListToolbarRow
          title={
            <Text
              role="heading"
              aria-level={1}
              numberOfLines={1}
              textRole="title"
              className="text-header-foreground"
            >
              {props.title}
            </Text>
          }
          search={
            search
              ? {
                  searching,
                  field: (
                    <SearchField
                      inputRef={inputRef}
                      accessibilityLabel={search.placeholder}
                      clearAccessibilityLabel={search.clearAccessibilityLabel ?? "Clear search"}
                      placeholder={search.placeholder}
                      value={search.value}
                      onChangeText={search.onChangeText}
                    />
                  ),
                  onClose: closeSearch,
                  onOpen: () => setSearchOpen(true),
                  accessibilityLabel: search.placeholder,
                }
              : undefined
          }
          filter={props.trailing}
        />
      </View>
    </>
  );
}
