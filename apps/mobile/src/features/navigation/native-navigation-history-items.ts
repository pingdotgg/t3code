import type { NativeStackHeaderItem } from "@react-navigation/native-stack";

import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function navigationIcon(name: "chevron.left" | "chevron.right"): NativeHeaderIcon {
  return { name, type: "sfSymbol" };
}

export function createNativeNavigationHistoryItems(input: {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly identifierPrefix: string;
  readonly onBack: () => void;
  readonly onForward: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      accessibilityLabel: "Back",
      disabled: !input.canGoBack,
      icon: navigationIcon("chevron.left"),
      identifier: `${input.identifierPrefix}-back`,
      label: "",
      onPress: input.onBack,
      type: "button" as const,
    }),
    withNativeGlassHeaderItem({
      accessibilityLabel: "Forward",
      disabled: !input.canGoForward,
      icon: navigationIcon("chevron.right"),
      identifier: `${input.identifierPrefix}-forward`,
      label: "",
      onPress: input.onForward,
      type: "button" as const,
    }),
  ];
}
