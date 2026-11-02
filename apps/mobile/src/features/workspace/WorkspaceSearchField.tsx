import type { Ref } from "react";
import { Keyboard, Pressable, TextInput, View, type TextInputInstance } from "react-native";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "../../components/ui/AppSymbol";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { WORKSPACE_TOOLBAR, type WorkspaceTab } from "./workspace-tabs-state";

export function WorkspaceSearchField({
  ref,
  ...props
}: {
  readonly ref?: Ref<TextInputInstance>;
  readonly tab: WorkspaceTab;
  readonly query: string;
  readonly onChangeQuery: (query: string) => void;
  readonly onFocus: () => void;
  readonly onBlur?: () => void;
  readonly onClear: () => void;
}) {
  const inputStyle = useResolveClassNames("text-foreground font-sans text-base");
  const placeholderStyle = useResolveClassNames("text-foreground-muted");
  const label = props.tab === "pullRequests" ? "Search pull requests" : "Search threads";
  return (
    <GlassSurface
      className="min-w-0 flex-1"
      style={{ height: WORKSPACE_TOOLBAR.height, borderRadius: WORKSPACE_TOOLBAR.height / 2 }}
    >
      <View className="flex-1 flex-row items-center pl-4">
        <SymbolView name="magnifyingglass" size={20} tintColorClassName="accent-icon-muted" />
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          placeholder={label}
          placeholderTextColor={placeholderStyle.color}
          value={props.query}
          onChangeText={props.onChangeQuery}
          onFocus={props.onFocus}
          onBlur={props.onBlur}
          onSubmitEditing={() => Keyboard.dismiss()}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxLength={props.tab === "pullRequests" ? 200 : undefined}
          style={[inputStyle, { flex: 1, minWidth: 0, paddingHorizontal: 8, paddingVertical: 0 }]}
        />
        {props.query ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            onPress={props.onClear}
            className="h-11 w-11 items-center justify-center"
          >
            <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
          </Pressable>
        ) : null}
      </View>
    </GlassSurface>
  );
}
