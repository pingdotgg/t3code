import { useNavigation } from "@react-navigation/native";
import { useRef, type ReactNode } from "react";
import { Platform, View, type TextInputInstance } from "react-native";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { SearchField } from "../../components/ui/SearchField";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { Toolbar } from "../../components/ui/Toolbar";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
} from "../layout/native-mail-search-toolbar";

/**
 * A searchable picker over a pull request list or a pull request: a pushed card with a search
 * field on Android, a sheet with the native search toolbar on iOS.
 */
export function PullRequestSearchSheet(props: {
  readonly title: string;
  readonly placeholder: string;
  readonly closeAccessibilityLabel: string;
  readonly clearAccessibilityLabel: string;
  readonly searchTextChangeId: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** Renders the list, given the bottom padding that keeps its end clear of the search bar. */
  readonly children: (list: { readonly paddingBottom: number }) => ReactNode;
}) {
  const navigation = useNavigation();
  const integratedSearch = useNativeMailSearchToolbar();
  const searchRef = useRef<TextInputInstance>(null);
  const list = props.children({
    paddingBottom: integratedSearch ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET + 16 : 16,
  });
  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <AndroidScreenHeader
          title={props.title}
          hideBottomBorder
          onBack={() => navigation.goBack()}
        />
        <View className="bg-header px-4 pb-3 pt-1">
          <SearchField
            inputRef={searchRef}
            accessibilityLabel={props.placeholder}
            clearAccessibilityLabel={props.clearAccessibilityLabel}
            onChangeText={props.onQueryChange}
            placeholder={props.placeholder}
            value={props.query}
          />
        </View>
        {list}
      </View>
    );
  }
  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader
        title={props.title}
        onClose={() => navigation.goBack()}
        accessibilityLabel={props.closeAccessibilityLabel}
      />
      <NativeStackScreenOptions
        options={{
          unstable_headerToolbarItems: integratedSearch
            ? () => [
                createNativeMailSearchToolbarItem({
                  placeholder: props.placeholder,
                  onSearchTextChange: props.onQueryChange,
                  showsSearchDismissButton: true,
                  searchTextChangeId: props.searchTextChangeId,
                }),
              ]
            : undefined,
          headerSearchBarOptions: integratedSearch
            ? undefined
            : {
                placeholder: props.placeholder,
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                obscureBackground: false,
                onChangeText: (event) => props.onQueryChange(event.nativeEvent.text),
                onCancelButtonPress: () => props.onQueryChange(""),
              },
        }}
      />
      {integratedSearch ? null : (
        <Toolbar placement="bottom">
          <Toolbar.SearchBarSlot />
        </Toolbar>
      )}
      {list}
    </View>
  );
}
