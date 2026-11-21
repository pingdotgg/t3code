import type { SFSymbol } from "expo-symbols";

export const directionalSymbols: Readonly<Partial<Record<string, SFSymbol>>> = {
  "chevron.left": "chevron.backward",
  "chevron.right": "chevron.forward",
  "arrow.left": "arrow.backward",
  "arrow.right": "arrow.forward",
  "arrow.right.circle": "arrow.forward.circle",
  "sidebar.left": "sidebar.leading",
  "sidebar.right": "sidebar.trailing",
};
