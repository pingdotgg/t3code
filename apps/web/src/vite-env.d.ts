/// <reference types="vite/client" />

import type { NativeApi, DesktopBridge } from "@t3tools/contracts";

declare global {
  interface Window {
    nativeApi?: NativeApi;
    desktopBridge?: DesktopBridge;
  }
}
