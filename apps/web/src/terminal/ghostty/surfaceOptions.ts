import type { GhosttyTheme } from "./core";
import type { GhosttyTerminalFont } from "./surfaceFonts";

export interface GhosttySelectionPosition {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme;
  readonly font?: GhosttyTerminalFont;
  /** Read after font and WASM loading. */
  readonly visible?: boolean;
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange: () => void;
  readonly beforeKey: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate: (text: string, event: MouseEvent) => void;
  readonly canActivateLink?: (text: string) => boolean;
  /** The host must prevent the default menu; native Paste cannot reach a canvas terminal. */
  readonly onContextMenu?: (event: MouseEvent) => void;
}
