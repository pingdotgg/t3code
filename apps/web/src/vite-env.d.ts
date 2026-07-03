/// <reference types="vite/client" />

import type { DesktopBridge, LocalApi } from "@t3tools/contracts";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

interface ImportMetaEnv {
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    nativeApi?: LocalApi;
    desktopBridge?: DesktopBridge;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: boolean;
          onLoadStart?: () => void;
        },
        HTMLElement
      >;
    }
  }
}
