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
