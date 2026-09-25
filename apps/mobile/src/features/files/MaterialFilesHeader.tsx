import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BackHandler, Keyboard, type TextInput, View } from "react-native";

import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { MaterialSearchField } from "../../components/MaterialSearchField";
import { useMaterialToolbarLayout } from "../../components/useMaterialToolbarLayout";

/** Keep Files search in the same header row on compact and expanded layouts. */
export function MaterialFilesHeader(props: {
  readonly projectName: string;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onBack?: () => void;
  readonly leading?: ReactNode;
}) {
  const { paddingTop, paddingBottom } = useMaterialToolbarLayout();
  const searchRef = useRef<TextInput>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;
  const { onSearchQueryChange } = props;
  const closeSearch = useCallback(() => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  }, [onSearchQueryChange]);

  useEffect(() => {
    if (!searching) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching]);

  return (
    <View>
      {/* Keep the title/subtitle's natural height, including larger text, while searching. */}
      <View
        pointerEvents={searching ? "none" : "auto"}
        accessibilityElementsHidden={searching}
        importantForAccessibility={searching ? "no-hide-descendants" : "auto"}
        style={{ opacity: searching ? 0 : 1 }}
      >
        <AndroidScreenHeader
          title="Files"
          subtitle={props.projectName}
          hideBottomBorder
          onBack={props.onBack}
          leading={props.leading}
          actions={[
            {
              accessibilityLabel: "Search files",
              icon: "magnifyingglass",
              onPress: () => setSearchOpen(true),
            },
          ]}
          trailing={
            <AndroidAnchoredMenu
              title="File options"
              actions={[{ id: "refresh", title: "Refresh files" }]}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "refresh") props.onRefresh();
              }}
            >
              {(open) => (
                <AndroidHeaderIconButton
                  accessibilityLabel="File options"
                  icon="ellipsis"
                  onPress={open}
                />
              )}
            </AndroidAnchoredMenu>
          }
        />
      </View>
      {searching ? (
        <View className="absolute inset-0 bg-header px-2" style={{ paddingTop, paddingBottom }}>
          <View className="flex-1 flex-row items-center gap-1">
            <AndroidHeaderIconButton
              accessibilityLabel="Close file search"
              icon="arrow.left"
              onPress={closeSearch}
            />
            <MaterialSearchField
              inputRef={searchRef}
              accessibilityLabel="Search files"
              clearAccessibilityLabel="Clear file search"
              placeholder="Search files"
              value={props.searchQuery}
              onChangeText={onSearchQueryChange}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
