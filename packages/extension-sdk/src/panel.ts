import type { InvocationContext, Json } from "./index.ts";

export interface ExtensionTheme {
  readonly appearance: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
}

export interface ExtensionPanelBridge {
  call(command: string, input?: Json): Promise<Json>;
  readonly context: InvocationContext;
  readonly theme: ExtensionTheme;
  readonly settings: Readonly<Record<string, Json>>;
  updateSettings(patch: Readonly<Record<string, Json>>): Promise<Readonly<Record<string, Json>>>;
  onThemeChanged(listener: (theme: ExtensionTheme) => void): () => void;
  onSettingsChanged(listener: (settings: Readonly<Record<string, Json>>) => void): () => void;
}

declare global {
  interface Window {
    t3Extension: ExtensionPanelBridge;
  }
}

export function getPanelBridge(): ExtensionPanelBridge {
  if (!window.t3Extension) throw new Error("Open this panel in T3 Code.");
  return window.t3Extension;
}
