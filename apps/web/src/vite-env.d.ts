/// <reference types="vite/client" />

import type { NativeApi, DesktopBridge } from "@t3tools/contracts";

declare global {
  interface LocalFontData {
    readonly family: string;
    readonly fullName: string;
    readonly postscriptName: string;
    readonly style: string;
    blob(): Promise<Blob>;
  }

  interface Window {
    nativeApi?: NativeApi;
    desktopBridge?: DesktopBridge;
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}
