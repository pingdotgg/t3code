import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "@t3tools/contracts";

export { DEFAULT_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE };

export const AUTOMATIC_TERMINAL_FONT_FAMILIES = [
  "JetBrainsMono Nerd Font",
  "MesloLGS NF",
  "FiraCode Nerd Font",
  "CaskaydiaCove Nerd Font",
  "Hack Nerd Font",
  "Noto Mono for Powerline",
  "SF Mono",
  "SFMono-Regular",
  "JetBrains Mono",
  "Consolas",
  "Liberation Mono",
  "Menlo",
] as const;

function quoteFontFamily(fontFamily: string): string {
  const escaped = fontFamily
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\r\n\f]/g, " ");
  return `"${escaped}"`;
}

export const AUTOMATIC_TERMINAL_FONT_FAMILY = [
  ...AUTOMATIC_TERMINAL_FONT_FAMILIES.map(quoteFontFamily),
  "monospace",
].join(", ");

export function resolveTerminalFontFamily(fontFamily: string): string {
  const normalized = fontFamily.trim();
  if (normalized.length === 0) return AUTOMATIC_TERMINAL_FONT_FAMILY;
  return `${quoteFontFamily(normalized)}, ${AUTOMATIC_TERMINAL_FONT_FAMILY}`;
}

export function normalizeTerminalFontSize(fontSize: number): number {
  if (!Number.isFinite(fontSize)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(fontSize)));
}

export function normalizeTerminalFontFamilyInput(fontFamily: string): string {
  return fontFamily.trim();
}

export function normalizeTerminalFontSizeInput(fontSize: string): number {
  const normalized = fontSize.trim();
  return normalizeTerminalFontSize(
    normalized.length === 0 ? DEFAULT_TERMINAL_FONT_SIZE : Number(normalized),
  );
}

export interface TerminalAppearanceUpdateState {
  generation: number;
}

interface TerminalAppearanceTarget {
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      readonly baseY: number;
    };
  };
  readonly cols: number;
  readonly rows: number;
  readonly options: {
    fontFamily?: string;
    fontSize?: number;
  };
  refresh(start: number, end: number): void;
  scrollToBottom(): void;
}

interface ApplyTerminalAppearanceOptions {
  readonly state: TerminalAppearanceUpdateState;
  readonly terminal: TerminalAppearanceTarget;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontsReady?: Promise<unknown> | undefined;
  readonly fit: () => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly isTargetCurrent?: (() => boolean) | undefined;
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (frame: number) => void;
}

export function applyTerminalAppearance(options: ApplyTerminalAppearanceOptions): () => void {
  const updateId = ++options.state.generation;
  let frame: number | null = null;

  options.terminal.options.fontFamily = options.fontFamily;
  options.terminal.options.fontSize = options.fontSize;

  const isCurrent = () =>
    updateId === options.state.generation && (options.isTargetCurrent?.() ?? true);
  const refitAndRefresh = () => {
    if (!isCurrent()) return;
    frame = options.requestFrame(() => {
      frame = null;
      if (!isCurrent()) return;
      const wasAtBottom =
        options.terminal.buffer.active.viewportY >= options.terminal.buffer.active.baseY;
      options.fit();
      if (wasAtBottom) {
        options.terminal.scrollToBottom();
      }
      options.terminal.refresh(0, Math.max(options.terminal.rows - 1, 0));
      options.resize(options.terminal.cols, options.terminal.rows);
    });
  };

  if (options.fontsReady) {
    void options.fontsReady.then(refitAndRefresh, refitAndRefresh);
  } else {
    refitAndRefresh();
  }

  return () => {
    if (isCurrent()) {
      options.state.generation += 1;
    }
    if (frame !== null) {
      options.cancelFrame(frame);
    }
  };
}
