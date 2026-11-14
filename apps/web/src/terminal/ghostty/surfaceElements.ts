import type { GhosttyTheme } from "./core";

export interface GhosttyTerminalElements {
  readonly canvas: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  readonly scrollbar: HTMLDivElement;
  readonly scrollbarThumb: HTMLDivElement;
  readonly context: CanvasRenderingContext2D;
}

export function createGhosttyTerminalElements(
  mount: HTMLElement,
  theme: GhosttyTheme,
): GhosttyTerminalElements {
  const canvas = document.createElement("canvas");
  canvas.className = "block size-full cursor-text";
  canvas.style.touchAction = "pan-x pinch-zoom";
  canvas.setAttribute("aria-hidden", "true");

  const input = document.createElement("textarea");
  input.className = "t3-ghostty-input";
  input.setAttribute("aria-label", "Terminal input");
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.cssText =
    "position:absolute;left:4px;top:4px;width:1px;height:1px;opacity:0;padding:0;border:0;resize:none;pointer-events:none;";

  const scrollbar = document.createElement("div");
  scrollbar.className =
    "group absolute top-1 right-px bottom-1 z-1 w-[var(--app-scrollbar-width)] cursor-default touch-none";
  scrollbar.setAttribute("role", "scrollbar");
  scrollbar.setAttribute("aria-label", "Terminal scrollback");
  scrollbar.setAttribute("aria-orientation", "vertical");
  scrollbar.tabIndex = 0;
  scrollbar.hidden = true;
  const scrollbarThumb = document.createElement("div");
  scrollbarThumb.className =
    "absolute inset-x-px top-0 rounded-[3px] bg-[var(--app-scrollbar-thumb)] transition-[background-color] duration-[120ms] ease-[ease-out] group-hover:bg-[var(--app-scrollbar-thumb-hover)] group-focus-visible:bg-[var(--app-scrollbar-thumb-hover)]";
  scrollbar.append(scrollbarThumb);
  mount.replaceChildren(canvas, input, scrollbar);

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.fillStyle = `rgb(${theme.background.r}, ${theme.background.g}, ${theme.background.b})`;
  context.fillRect(0, 0, canvas.width, canvas.height);

  return { canvas, input, scrollbar, scrollbarThumb, context };
}
