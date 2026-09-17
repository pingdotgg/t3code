import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BackHandler, Keyboard, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";

/** Keep Files search in the same header row on compact and expanded layouts. */
export function MaterialFilesHeader(props: {
  readonly projectName: string;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onBack?: () => void;
  readonly leading?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
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
            {
              accessibilityLabel: "Refresh files",
              icon: "arrow.clockwise",
              onPress: props.onRefresh,
            },
          ]}
        />
      </View>
      {searching ? (
        <View
          className="absolute inset-0 bg-header px-2 pb-2"
          style={{ paddingTop: Math.max(insets.top, 12) }}
        >
          <View className="min-h-14 flex-1 flex-row items-center gap-1">
            <AndroidHeaderIconButton
              accessibilityLabel="Close file search"
              icon="arrow.left"
              onPress={closeSearch}
            />
            <View className="h-12 min-w-0 flex-1 flex-row items-center gap-2 rounded-full border border-input-border bg-input px-3">
              <SymbolView
                name="magnifyingglass"
                size={18}
                tintColorClassName="accent-foreground-muted"
              />
              <TextInput
                ref={searchRef}
                accessibilityLabel="Search files"
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                placeholder="Search files"
                placeholderTextColorClassName="accent-placeholder"
                selectionColorClassName="accent-primary/32"
                cursorColorClassName="accent-primary"
                selectionHandleColorClassName="accent-primary"
                className="min-w-0 flex-1 py-2 font-sans text-base text-foreground"
                value={props.searchQuery}
                onChangeText={onSearchQueryChange}
              />
              {props.searchQuery.length > 0 ? (
                <Pressable
                  accessibilityLabel="Clear file search"
                  accessibilityRole="button"
                  hitSlop={10}
                  onPress={() => {
                    onSearchQueryChange("");
                    searchRef.current?.focus();
                  }}
                >
                  <SymbolView
                    name="xmark.circle.fill"
                    size={18}
                    tintColorClassName="accent-foreground-muted"
                  />
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}
