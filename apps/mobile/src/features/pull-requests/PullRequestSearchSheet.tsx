import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET } from "../layout/native-mail-search-toolbar";

/** A searchable picker over a pull request list or a pull request. */
export function PullRequestSearchSheet(props: {
  readonly title: string;
  readonly placeholder: string;
  readonly closeAccessibilityLabel: string;
  readonly clearAccessibilityLabel: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** Renders the list, given the bottom padding that keeps its end clear of the search bar. */
  readonly children: (list: { readonly paddingBottom: number }) => ReactNode;
}) {
  const navigation = useNavigation();
  // The compact search toolbar floats over the end of the list.
  const bottomSearch = useNativeMailSearchToolbar();
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <AppBar
        title={props.title}
        onClose={() => navigation.goBack()}
        closeAccessibilityLabel={props.closeAccessibilityLabel}
        hideBottomBorder
        search={{
          mode: "inline",
          compactToolbar: true,
          value: props.query,
          onChangeText: props.onQueryChange,
          placeholder: props.placeholder,
          clearAccessibilityLabel: props.clearAccessibilityLabel,
        }}
      />
      {props.children({
        // Android's bottom inset also covers the floating workspace tabs while Settings is open.
        paddingBottom:
          Platform.OS === "android"
            ? insets.bottom + 16
            : bottomSearch
              ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET + 16
              : 16,
      })}
    </View>
  );
}
