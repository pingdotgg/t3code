/// <reference types="vite/client" />

import type { NativeApi } from "@t3tools/contracts";

interface DesktopBridge {
  getWsUrl: () => string | null;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  showContextMenu: (items: readonly { id: string; label: string }[]) => Promise<string | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
}

declare global {
  interface Window {
    nativeApi?: NativeApi;
    desktopBridge?: DesktopBridge;
  }
}
