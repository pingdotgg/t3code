import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-bottom-safe-area-inset", {
  filename: "fixture.tsx",
});

describe("t3code/require-bottom-safe-area-inset", () => {
  rule.valid(
    "allows bottom offsets outside React Native files",
    `
      export const style = { position: "absolute", bottom: 16, right: 16 };
    `,
  );

  rule.valid(
    "allows a floating button that reserves the safe-area inset",
    `
      import { Pressable } from "react-native";
      import { useSafeAreaInsets } from "react-native-safe-area-context";

      export function ShowKeyboardButton() {
        const insets = useSafeAreaInsets();
        return (
          <Pressable
            style={{ position: "absolute", bottom: Math.max(insets.bottom, 16) + 16, right: 16 }}
          />
        );
      }
    `,
  );

  rule.valid(
    "allows an edge-attached overlay whose child owns the padding",
    `
      import { View } from "react-native";
      import { KeyboardStickyView } from "react-native-keyboard-controller";

      export function ComposerOverlay(props: { readonly bottomInset: number }) {
        return (
          <KeyboardStickyView style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
            <View style={{ paddingBottom: props.bottomInset }} />
          </KeyboardStickyView>
        );
      }
    `,
  );

  rule.valid(
    "allows list padding that is derived from the inset",
    `
      import { FlatList } from "react-native";
      import { useSafeAreaInsets } from "react-native-safe-area-context";

      export function FileList() {
        const insets = useSafeAreaInsets();
        return (
          <FlatList
            data={[]}
            renderItem={() => null}
            contentContainerStyle={{ paddingTop: 8, paddingBottom: Math.max(insets.bottom, 18) + 18 }}
          />
        );
      }
    `,
  );

  rule.valid(
    "allows a nested callback that closes over its component's inset",
    `
      import { FlatList, View } from "react-native";
      import { useSafeAreaInsets } from "react-native-safe-area-context";

      export function FileList() {
        const insets = useSafeAreaInsets();
        return (
          <FlatList
            data={[]}
            renderItem={() => <View style={{ position: "absolute", bottom: insets.bottom + 8 }} />}
            contentContainerStyle={{ paddingBottom: insets.bottom }}
          />
        );
      }
    `,
  );

  rule.valid(
    "allows an inline scroll view bounded by an explicit height",
    `
      import { ScrollView, Text } from "react-native";

      export function Caption(props: { readonly source: string }) {
        return (
          <ScrollView
            style={{ maxHeight: 88, flexGrow: 0 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8 }}
          >
            <Text>{props.source}</Text>
          </ScrollView>
        );
      }
    `,
  );

  rule.valid(
    "allows a style array whose last element resets the anchor to the edge",
    `
      import { View } from "react-native";

      export function Overlay() {
        return <View style={[{ position: "absolute", bottom: 16 }, { bottom: 0 }]} />;
      }
    `,
  );

  rule.invalid(
    "reports an anchor split across style array elements",
    `
      import { Pressable } from "react-native";

      export function ShowKeyboardButton() {
        return <Pressable style={[{ position: "absolute" }, { bottom: 16, right: 16 }]} />;
      }
    `,
    (output) => {
      assert.match(output, /safe-area inset/);
    },
  );

  rule.invalid(
    "reports an anchor guarded by a condition inside a style array",
    `
      import { Pressable } from "react-native";

      export function ShowKeyboardButton(props: { readonly floating: boolean }) {
        return (
          <Pressable
            style={[{ right: 16 }, props.floating && { position: "absolute", bottom: 16 }]}
          />
        );
      }
    `,
    (output) => {
      assert.match(output, /safe-area inset/);
    },
  );

  rule.invalid(
    "reports an anchor on JSX rendered inside an array",
    `
      import { View } from "react-native";

      export function Overlays() {
        return [<View key="fab" style={{ position: "absolute", bottom: 16 }} />];
      }
    `,
    (output) => {
      assert.match(output, /safe-area inset/);
    },
  );

  rule.invalid(
    "reports a screen-filling list sized with a percentage height",
    `
      import { FlatList } from "react-native";

      export function FileList() {
        return (
          <FlatList
            data={[]}
            renderItem={() => null}
            style={{ height: "100%" }}
            contentContainerStyle={{ paddingBottom: 8 }}
          />
        );
      }
    `,
    (output) => {
      assert.match(output, /safe-area inset/);
    },
  );

  rule.invalid(
    "reports a component that ignores the inset even when a sibling component reads it",
    `
      import { Pressable, View } from "react-native";
      import { useSafeAreaInsets } from "react-native-safe-area-context";

      function Header() {
        const insets = useSafeAreaInsets();
        return <View style={{ paddingBottom: insets.bottom }} />;
      }

      export function Screen() {
        return (
          <View>
            <Header />
            <Pressable style={{ position: "absolute", bottom: 16, right: 16 }} />
          </View>
        );
      }
    `,
    (output) => {
      assert.match(output, /safe-area inset/);
    },
  );

  rule.invalid(
    "reports a fixed bottom padding inside a style array",
    `
      import { FlatList, StyleSheet } from "react-native";

      const styles = StyleSheet.create({ base: { paddingTop: 8 } });

      export function FileList() {
        return (
          <FlatList
            data={[]}
            renderItem={() => null}
            contentContainerStyle={[styles.base, { paddingBottom: 8 }]}
          />
        );
      }
    `,
    (output) => {
      assert.match(output, /safe-area inset/);
    },
  );

  rule.invalid(
    "reports a floating button pinned with a fixed bottom offset",
    `
      import { Pressable } from "react-native";

      export function ShowKeyboardButton() {
        return <Pressable style={{ position: "absolute", bottom: 16, right: 16 }} />;
      }
    `,
    (output) => {
      assert.match(output, /safe-area inset/);
    },
  );

  rule.invalid(
    "reports list content padding that ignores the bottom inset",
    `
      import { FlatList } from "react-native";

      export function FileList() {
        return (
          <FlatList
            data={[]}
            renderItem={() => null}
            contentContainerStyle={{ paddingTop: 8, paddingBottom: 8 }}
          />
        );
      }
    `,
    (output) => {
      assert.match(output, /insets\.bottom/);
    },
  );
});
