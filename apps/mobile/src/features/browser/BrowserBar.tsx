import { useState, type ReactNode } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { ControlPill } from "../../components/ui/ControlPill";

/** The one-row chrome above a browser page: close, back, address with reload, then `trailing`. */
export function BrowserBar(props: {
  readonly url: string;
  readonly editable: boolean;
  readonly canGoBack: boolean;
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly onReload: () => void;
  readonly onSubmit: (value: string) => void;
  readonly trailing?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <View
      className="flex-row items-center gap-1 pb-1.5"
      style={{
        paddingTop: insets.top + 4,
        paddingLeft: insets.left + 8,
        paddingRight: insets.right + 8,
      }}
    >
      <ControlPill icon="xmark" accessibilityLabel="Close browser" onPress={props.onClose} />
      {props.canGoBack ? (
        <ControlPill icon="chevron.left" accessibilityLabel="Back" onPress={props.onBack} />
      ) : null}
      {/* On a tablet the address stays a readable width, centered between the buttons. */}
      <View className="min-w-0 flex-1 items-center">
        <View className="h-10 w-full max-w-2xl flex-row items-center rounded-full bg-input pl-4">
          <TextInput
            accessibilityLabel="Address"
            editable={props.editable}
            // Unfocused, the field shows only host and path; editing starts from the full URL.
            value={draft ?? displayAddress(props.url)}
            onFocus={() => setDraft(props.url)}
            onChangeText={setDraft}
            onBlur={() => setDraft(null)}
            onSubmitEditing={() => {
              const value = draft ?? props.url;
              setDraft(null);
              props.onSubmit(value);
            }}
            placeholder="Enter a URL"
            placeholderTextColorClassName="accent-placeholder"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            selectTextOnFocus
            lineBreakModeIOS="middle"
            numberOfLines={1}
            className="h-10 min-w-0 flex-1 font-sans text-sm text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reload page"
            disabled={!props.editable}
            onPress={props.onReload}
            className="size-10 items-center justify-center"
          >
            <SymbolView
              name="arrow.clockwise"
              size={16}
              tintColorClassName={props.editable ? "accent-icon" : "accent-icon-subtle"}
            />
          </Pressable>
        </View>
      </View>
      {props.trailing}
    </View>
  );
}

function displayAddress(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  } catch {
    return value;
  }
}
