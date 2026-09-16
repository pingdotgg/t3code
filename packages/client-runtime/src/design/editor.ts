// @effect-diagnostics globalDate:off - This isolated Electron preload does not run inside an Effect runtime.
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewDesignChangePayload,
} from "@t3tools/contracts";

import {
  applyDesignElementState as applyState,
  captureDesignElementState as stateOf,
  createDesignSelectionAnnotation,
  DESIGN_EDITING_ATTRIBUTE,
  DESIGN_OPEN_ATTRIBUTE,
  DESIGN_UI_ATTRIBUTE,
  designElementStatesMatch as statesMatch,
  designColorWithAlpha,
  rgbToHex,
  cancelDesignInteraction,
  resolveDesignPosition,
  serializeDesignDocument,
  type DesignElementState as ElementState,
} from "./document.ts";
import { applyAnnotationTheme } from "./theme.ts";

type Tool =
  | "select"
  | "hand"
  | "draw"
  | "arrow"
  | "line"
  | "box"
  | "diamond"
  | "circle"
  | "highlight";
type Point = { x: number; y: number };
type Guide = { x: number; y: number; width: number; height: number };
type HistoryEntry = { undo: () => void; redo: () => void };
type DragState =
  | {
      kind: "move";
      start: Point;
    }
  | {
      kind: "resize";
      start: Point;
      width: number;
      height: number;
      direction: string;
    }
  | {
      kind: "create";
      tool: Exclude<Tool, "select" | "hand">;
      start: Point;
      element: HTMLElement | SVGSVGElement;
      points: Point[];
    };

const OBJECT_ATTRIBUTE = "data-t3-design-object";
const GROUP_ATTRIBUTE = "data-t3-design-groups";
const LOCK_ATTRIBUTE = "data-t3-design-locked";
const FOCUS_ATTRIBUTE = "data-t3-design-focus";
const SELECTED_ATTRIBUTE = "data-t3-design-selected";
const ARTBOARD_SELECTOR = "[data-t3-design-artboard]";
const SAVE_DELAY_MS = 200;
const MIN_SHAPE_SIZE = 5;

const ICONS = {
  select:
    '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
  draw: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  arrow: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  box: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="10"/>',
  highlight:
    '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  attach:
    '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
} as const;
export function startDesignEditor(
  window: Window & typeof globalThis,
  options: {
    url: string;
    onChange: (change: DesktopPreviewDesignChangePayload) => Promise<void>;
    theme?: DesktopPreviewAnnotationTheme | null;
  },
) {
  const {
    document,
    Element,
    HTMLElement,
    SVGElement,
    SVGSVGElement,
    HTMLInputElement,
    HTMLSelectElement,
    HTMLTextAreaElement,
    Option,
    Node,
    Event,
    MutationObserver,
    CSS,
    navigator,
    URL,
    Blob,
  } = window;
  const getComputedStyle = window.getComputedStyle.bind(window);
  const ANNOTATION_TOOL_ATTRIBUTE = "data-t3code-annotation-tool";
  let idSequence = 0;
  const svgIcon = (icon: string): string =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;

  function nextId(): string {
    let id: string;
    do {
      idSequence += 1;
      id = `manual-${idSequence}`;
    } while (
      document.getElementById(id) ||
      document.querySelector(`[data-t3-design-id="${id}"],[${GROUP_ATTRIBUTE}~="${id}"]`)
    );
    return id;
  }

  function isUiElement(value: EventTarget | null): boolean {
    return value instanceof Element && value.closest(`[${DESIGN_UI_ATTRIBUTE}]`) !== null;
  }

  function targetFromPoint(x: number, y: number): Element | null {
    const target = document
      .elementsFromPoint(x, y)
      .find(
        (element) =>
          !isUiElement(element) &&
          !element.closest(`[${LOCK_ATTRIBUTE}]`) &&
          element !== document.documentElement &&
          element !== document.body &&
          !(element.querySelector(ARTBOARD_SELECTOR) && !element.matches(ARTBOARD_SELECTOR)) &&
          !["SCRIPT", "STYLE", "LINK", "META"].includes(element.tagName),
      );
    return target?.closest(`[${OBJECT_ATTRIBUTE}]`) ?? target ?? null;
  }

  const host = document.createElement("div");
  host.setAttribute(DESIGN_UI_ATTRIBUTE, "");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "closed" });
  const pageStyle = document.createElement("style");
  pageStyle.setAttribute(DESIGN_UI_ATTRIBUTE, "");
  pageStyle.textContent = `
    html[${DESIGN_OPEN_ATTRIBUTE}]{overflow:hidden!important;overscroll-behavior:none;background:var(--t3-canvas-background,#f8f9fb)!important}
    html[${DESIGN_OPEN_ATTRIBUTE}] body{transform-origin:0 0!important;transform:translate3d(var(--t3-canvas-x,0px),var(--t3-canvas-y,0px),0) scale(var(--t3-canvas-zoom,1))!important}
    html[${DESIGN_OPEN_ATTRIBUTE}]:has(${ARTBOARD_SELECTOR}) body:not(${ARTBOARD_SELECTOR}){background:transparent!important}
    html[${DESIGN_OPEN_ATTRIBUTE}],html[${DESIGN_OPEN_ATTRIBUTE}] body *{cursor:var(--t3-canvas-cursor,default)!important}
    @media print{[${DESIGN_UI_ATTRIBUTE}]{display:none!important}html[${DESIGN_OPEN_ATTRIBUTE}]{overflow:visible!important}html[${DESIGN_OPEN_ATTRIBUTE}] body{transform:none!important}}
  `;
  document.head.appendChild(pageStyle);
  const style = document.createElement("style");
  style.textContent = `
    :host{
      color-scheme:light dark;
      --bg:var(--t3-background,light-dark(#fff,#161616));
      --fg:var(--t3-foreground,light-dark(#262626,#ededed));
      --popover:var(--t3-popover,light-dark(#fff,#1c1c1c));
      --primary:var(--t3-primary,oklch(0.488 0.217 264));
      --primary-fg:var(--t3-primary-foreground,#fff);
      --muted:var(--t3-muted,light-dark(rgb(0 0 0/4%),rgb(255 255 255/6%)));
      --muted-fg:var(--t3-muted-foreground,light-dark(#737373,#9a9a9a));
      --accent:var(--t3-accent,light-dark(rgb(0 0 0/5%),rgb(255 255 255/8%)));
      --accent-fg:var(--t3-accent-foreground,var(--fg));
      --border:var(--t3-border,light-dark(rgb(0 0 0/8%),rgb(255 255 255/10%)));
      --input:var(--t3-input,light-dark(rgb(0 0 0/12%),rgb(255 255 255/14%)));
      --ring:var(--t3-ring,var(--primary));
      --radius:var(--t3-radius,0.625rem);
      --radius-sm:calc(var(--radius) - 4px);
      --radius-md:calc(var(--radius) - 2px);
      --ease:cubic-bezier(.23,1,.32,1);
      font:12px/1.4 var(--t3-font-sans,ui-sans-serif,system-ui,sans-serif);
      color:var(--fg);
      -webkit-font-smoothing:antialiased;
    }
    *{box-sizing:border-box}
    button,input,textarea,select{font:inherit;color:inherit;margin:0}
    button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;border:0;border-radius:var(--radius-md);background:transparent;padding:0 9px;cursor:pointer;white-space:nowrap;transition:transform 140ms var(--ease),background-color 120ms ease,color 120ms ease,opacity 120ms ease}
    button:active:not(:disabled){transform:scale(.97)}
    button:disabled{opacity:.4;cursor:default}
    button svg{width:15px;height:15px;flex:none}
    button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid color-mix(in srgb,var(--ring) 70%,transparent);outline-offset:1px}
    .panel{pointer-events:auto;position:fixed;z-index:4;right:16px;top:76px;bottom:16px;display:flex;width:248px;flex-direction:column;overflow:hidden;border:1px solid var(--border);border-radius:9px;background:var(--bg);box-shadow:0 2px 12px rgb(0 0 0/8%)}
    .panel[hidden]{display:none}
    .panel-header{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:8px 12px 0}
    .panel-title{font-size:13px;font-weight:600;letter-spacing:-.01em}
    .status{flex:1;overflow:hidden;color:var(--muted-fg);font-size:11px;text-overflow:ellipsis;white-space:nowrap;transition:color 160ms ease}
    .status[data-dirty]{color:color-mix(in srgb,var(--fg) 70%,var(--muted-fg))}
    .panel-header .save{height:26px;padding:0 10px;border:1px solid var(--border);background:var(--popover);font-weight:500;box-shadow:0 1px 2px rgb(0 0 0/6%)}
    .editor-body{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
    .top-bar{position:fixed;z-index:7;top:16px;left:16px;right:16px;display:flex;align-items:center;gap:12px;pointer-events:none}
    .tool-group{position:relative;display:flex;justify-content:center;flex:1;min-width:0}
    .tools{pointer-events:auto;display:flex;align-items:center;gap:4px;min-width:0;max-width:100%;height:36px;padding:3px;border:1px solid var(--border);border-radius:9px;background:var(--bg);box-shadow:0 2px 12px rgb(0 0 0/8%);overflow-x:auto;scrollbar-width:none}
    .tools button{position:relative;flex:none;width:36px;height:28px;padding:6px;color:var(--muted-fg);border-radius:6px}
    .tools button svg{width:16px;height:16px}
    .tools button[aria-pressed=true]{background:var(--accent);color:var(--primary)}
    .tools .divider{width:1px;height:18px;margin:auto 2px;background:var(--border);grid-column:auto}
    .section{padding:10px 14px 12px;border-top:1px solid var(--border)}
    .editor-body>.section:first-of-type{border-top:0}
    .section-title{display:flex;align-items:center;justify-content:space-between;margin:0 0 8px;color:var(--fg);font-size:12px;font-weight:500}
    .layers{margin:2px -4px 0;max-height:40vh;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
    .layer-row{display:flex;align-items:center;gap:2px}
    .layer-chevron{width:16px;height:22px;flex:none;padding:0;border-radius:4px;color:var(--muted-fg);font-size:8px}
    .layer-spacer{width:16px;flex:none}
    .layer{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:24px;overflow:hidden;border-radius:var(--radius-sm);padding:0 6px;text-align:left;color:var(--muted-fg);font-weight:400}
    .layer>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .layer .layer-tag{flex:none;margin-left:auto;color:var(--muted-fg);font-family:var(--t3-font-mono,ui-monospace,monospace);font-size:10px;text-transform:lowercase}
    .layer[aria-selected=true]{background:var(--accent);color:var(--accent-fg);font-weight:500}
    .panel-empty{margin:0 0 4px;color:var(--muted-fg);font-size:11px}
    .hint{position:absolute;top:calc(100% + 12px);left:50%;transform:translateX(-50%);width:max-content;max-width:100%;padding:0;color:var(--muted-fg);text-align:center;font-size:11px;pointer-events:none}
    .hint strong{display:block;margin-bottom:4px;color:var(--fg);font-weight:600}
    .hint kbd{display:inline-block;min-width:18px;border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;padding:0 4px;font:inherit;font-size:10px;line-height:16px;color:var(--fg)}
    .inspector{display:none}
    .inspector h2{display:flex;align-items:center;gap:8px;margin:0;font-size:12px;font-weight:600;overflow:hidden}
    .inspector h2 .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .inspector h2 .tagname{flex:none;border-radius:4px;padding:1px 5px;background:var(--muted);color:var(--muted-fg);font-family:var(--t3-font-mono,ui-monospace,monospace);font-size:10px;font-weight:500;text-transform:lowercase}
    .field{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:center;gap:8px;margin-top:8px;color:var(--muted-fg);font-size:11px}
    .field>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .field input,.field textarea,.field select{min-width:0;width:100%;border:1px solid var(--input);border-radius:var(--radius-md);background:var(--popover);padding:0 8px;color:var(--fg);outline:none;box-shadow:0 1px 2px rgb(0 0 0/4%);transition:border-color 120ms ease,box-shadow 120ms ease}
    .field input,.field select{height:28px}
    .field textarea{height:60px;padding:6px 8px;resize:vertical;line-height:1.4}
    .field input:hover,.field textarea:hover,.field select:hover{border-color:color-mix(in srgb,var(--input) 60%,var(--fg) 15%)}
    .field input:focus,.field textarea:focus,.field select:focus{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 22%,transparent);outline:none}
    .field input:disabled,.field textarea:disabled{opacity:.5}
    .field input[type=number]{font-variant-numeric:tabular-nums}
    .field input[type=number]::-webkit-inner-spin-button,.field input[type=number]::-webkit-outer-spin-button{appearance:none;margin:0}
    .field select{appearance:none;padding-right:24px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 7px center;background-size:12px}
    .color-control{display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px}
    .field input[type=color]{width:28px;height:28px;padding:2px;cursor:pointer}
    .field input[type=color]::-webkit-color-swatch-wrapper{padding:0}
    .field input[type=color]::-webkit-color-swatch{border:1px solid rgb(0 0 0/10%);border-radius:3px}
    .field input[type=text]{font-family:var(--t3-font-mono,ui-monospace,monospace);font-size:11px}
    .actions{display:flex;gap:6px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--border);background:var(--bg)}
    .actions button{flex:1;height:32px;min-width:32px;padding:0 6px;border:0;background:var(--muted);color:var(--muted-fg)}
    .actions button:not(:disabled){color:var(--fg)}
    .design-choice{width:100%}
    .design-choice p{margin:6px 0 0;color:var(--muted-fg);font-size:11px;line-height:1.4}
    .actions .choose{width:100%;padding:0 10px;font-weight:500}
    .actions .choose[data-chosen]{border-color:color-mix(in srgb,var(--primary) 35%,transparent);background:color-mix(in srgb,var(--primary) 10%,transparent);color:var(--primary)}
    .actions .delete:not(:disabled):hover{color:#dc2626}
    .actions .attach{grid-column:1/-1;border-color:var(--primary);background:var(--primary);color:var(--primary-fg);font-weight:500;box-shadow:0 1px 2px rgb(0 0 0/12%)}
    .actions .attach:not(:disabled):hover{background:color-mix(in srgb,var(--primary) 90%,#000)}
    .hover{display:none;pointer-events:none;position:fixed;z-index:0;border:1.5px solid var(--primary);background:color-mix(in srgb,var(--primary) 8%,transparent);border-radius:3px;will-change:transform}
    .selection{display:none;pointer-events:none;position:fixed;z-index:1;border:1px solid var(--primary)}
    .tag{position:absolute;left:-1.5px;bottom:calc(100% + 6px);display:flex;align-items:center;gap:5px;max-width:220px;height:20px;overflow:hidden;border-radius:5px;background:var(--primary);color:var(--primary-fg);padding:0 7px;font-size:11px;font-weight:500;white-space:nowrap;box-shadow:0 2px 6px rgb(0 0 0/18%)}
    .tag .size{opacity:.75;font-variant-numeric:tabular-nums;font-weight:400}
    .selection[data-tag-below] .tag{bottom:auto;top:calc(100% + 6px)}
    .handle{pointer-events:auto;position:absolute;width:9px;height:9px;border:1.5px solid var(--primary);border-radius:2px;background:#fff;padding:0;box-shadow:0 1px 3px rgb(0 0 0/25%);transition:transform 120ms var(--ease)}
    .handle:hover{transform:scale(1.25)}
    .nw{left:-5px;top:-5px;cursor:nwse-resize}.ne{right:-5px;top:-5px;cursor:nesw-resize}.sw{left:-5px;bottom:-5px;cursor:nesw-resize}.se{right:-5px;bottom:-5px;cursor:nwse-resize}
    .text-toolbar{pointer-events:auto;position:fixed;z-index:6;display:none;align-items:center;gap:1px;padding:4px;border:1px solid var(--border);border-radius:10px;background:var(--popover);color:var(--fg);box-shadow:0 8px 24px -4px rgb(0 0 0/22%),0 1px 2px rgb(0 0 0/8%)}
    .text-toolbar button{min-width:26px;height:26px;padding:0 6px;font-size:12px}
    .text-toolbar .divider{width:1px;height:16px;margin:0 3px;background:var(--border)}
    .guides{pointer-events:none;position:fixed;inset:0;z-index:3;overflow:hidden}
    .guide{position:absolute;left:0;top:0;background:#f24e1e;opacity:.9}
    .text-toolbar .bold{font-weight:700}.text-toolbar .italic{font-style:italic}.text-toolbar .underline{text-decoration:underline}
    @media (hover:hover) and (pointer:fine){
      button:hover:not(:disabled){background:var(--accent);color:var(--accent-fg)}
      .tools button[aria-pressed=true]:hover{color:var(--primary)}
      .layer:hover{color:var(--fg)}
      .actions .attach:not(:disabled):hover{color:var(--primary-fg)}
      .panel-header .save:hover{background:var(--accent)}
    }
    [hidden]{display:none!important}
    .shortcut{position:absolute;bottom:1px;right:3px;font-size:9px;line-height:11px;opacity:.65}
    .tools button[aria-pressed=true]{background:color-mix(in srgb,var(--primary) 12%,var(--bg));color:var(--primary)}
    .top-actions{pointer-events:auto;position:relative;flex:none;display:flex;align-items:center;gap:8px}
    .top-actions>button{height:36px;padding:0 9px;font-size:11px;border-radius:9px;background:var(--bg);border:1px solid var(--border)}
    .top-actions .attach{gap:4px;background:var(--primary);color:var(--primary-fg);border-color:transparent}
    .top-actions .attach svg,.top-actions .edit svg{width:14px;height:14px}
    .top-actions .edit{gap:5px}
    .top-actions .edit[aria-pressed=true]{background:var(--accent);color:var(--primary)}
    .top-actions .status{position:absolute;top:44px;right:0;max-width:100%;font-size:10px}
    .bottom-controls,.history-controls{pointer-events:auto;position:fixed;z-index:5;bottom:16px;left:16px;display:flex;align-items:center;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--fg)}
    .bottom-controls>button,.history-controls>button{width:36px;height:36px;padding:8px}.history-controls{left:174px}
    summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}.zoom-menu>summary{display:grid;place-items:center;min-width:70px;height:36px;font-variant-numeric:tabular-nums}
    .menu-options{position:absolute;display:flex;flex-direction:column;gap:2px;min-width:190px;padding:8px;border:1px solid var(--border);border-radius:12px;background:var(--bg);box-shadow:0 4px 24px rgb(0 0 0/12%)}.menu-options button{height:34px;justify-content:flex-start}.zoom-menu .menu-options{left:0;bottom:44px}
    .canvas-menu{pointer-events:auto;position:relative;flex:none}.canvas-menu>summary{display:grid;place-items:center;width:36px;height:36px;border-radius:9px;background:var(--bg);border:1px solid var(--border)}.canvas-menu svg{width:18px;height:18px}.canvas-menu .menu-options{left:0;top:44px}
    .help-button{pointer-events:auto;position:fixed;z-index:5;bottom:16px;right:16px;width:36px;height:36px;border:1px solid var(--border);border-radius:9px;background:var(--bg)}
    .panel:not([hidden])~.help-button{right:280px}
    .canvas-help{pointer-events:auto;width:min(440px,calc(100% - 32px));border:1px solid var(--border);border-radius:16px;background:var(--bg);color:var(--fg);padding:16px;box-shadow:0 12px 60px rgb(0 0 0/20%)}.canvas-help::backdrop{background:rgb(0 0 0/35%)}.canvas-help h2{font-size:16px;margin:0 32px 16px 0}.canvas-help dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin:0}.canvas-help dd{margin:0;color:var(--muted-fg)}.canvas-help .close{position:absolute;top:10px;right:10px;width:28px;height:28px;padding:0}
    .inspector details>summary,.layers-details>summary{padding:10px 14px;color:var(--muted-fg);border-top:1px solid var(--border);font-size:11px}.layers-details{border-bottom:1px solid var(--border)}.layers-details>summary{border-top:0}.layers-details .layers{padding:0 10px 10px}
    .swatches{display:flex;gap:5px;padding-top:8px}.swatches>button{width:24px;height:24px;padding:0;border-radius:4px;border:1px solid rgb(0 0 0/10%)}
    @media(max-width:600px){.top-bar{left:12px;right:12px;gap:8px}.tools{gap:2px}.tools button{width:30px}.panel{right:12px;width:220px}.panel:not([hidden])~.help-button{right:244px}.hint{display:none}.status{max-width:80px!important}}
    @media (prefers-reduced-motion:reduce){*{transition:none!important}}
  `;
  root.appendChild(style);

  const toolbar = document.createElement("aside");
  toolbar.className = "panel";
  toolbar.setAttribute("aria-label", "Design");
  const panelHeader = document.createElement("div");
  panelHeader.className = "panel-header";
  const panelTitle = document.createElement("span");
  panelTitle.className = "panel-title";
  panelTitle.textContent = "Design";
  const status = document.createElement("span");
  status.className = "status";
  status.setAttribute("aria-live", "polite");
  const saveNow = document.createElement("button");
  saveNow.type = "button";
  saveNow.className = "save";
  saveNow.textContent = "Save";
  panelHeader.append(panelTitle, status, saveNow);
  const editPanel = document.createElement("div");
  editPanel.className = "editor-body";
  const editTools = document.createElement("div");
  editTools.className = "tools";
  const layersDetails = document.createElement("details");
  layersDetails.className = "layers-details";
  layersDetails.open = true;
  const layersSummary = document.createElement("summary");
  layersSummary.textContent = "Layers";
  const layers = document.createElement("div");
  layers.className = "layers";
  layersDetails.append(layersSummary, layers);
  const emptyHint = document.createElement("p");
  emptyHint.className = "panel-empty";
  emptyHint.textContent = "Select an element to edit it";
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.innerHTML = "Hold Space to pan · Pinch to zoom · Double-click text to edit";
  const hover = document.createElement("div");
  hover.className = "hover";
  const selection = document.createElement("div");
  selection.className = "selection";
  const tag = document.createElement("div");
  tag.className = "tag";
  const tagName = document.createElement("span");
  const tagSize = document.createElement("span");
  tagSize.className = "size";
  tag.append(tagName, tagSize);
  selection.appendChild(tag);
  const inspector = document.createElement("div");
  inspector.className = "inspector";
  const inspectorTitle = document.createElement("h2");
  const inspectorName = document.createElement("span");
  inspectorName.className = "name";
  const inspectorTag = document.createElement("span");
  inspectorTag.className = "tagname";
  inspectorTitle.append(inspectorName, inspectorTag);
  const selectionSection = document.createElement("section");
  selectionSection.className = "section";
  selectionSection.appendChild(inspectorTitle);
  editPanel.append(selectionSection, emptyHint, layersDetails, inspector);
  const actions = document.createElement("div");
  actions.className = "actions";
  const textToolbar = document.createElement("div");
  textToolbar.className = "text-toolbar";
  toolbar.append(panelHeader, editPanel, actions);
  toolbar.hidden = true;
  root.append(toolbar, hover, selection, textToolbar);
  root.append(editTools);
  editTools.setAttribute("role", "toolbar");
  editTools.setAttribute("aria-label", "Drawing tools");
  const topActions = document.createElement("div");
  topActions.className = "top-actions";
  topActions.append(status);
  const bottom = document.createElement("div");
  bottom.className = "bottom-controls";
  const historyControls = document.createElement("div");
  historyControls.className = "history-controls";
  root.append(topActions, bottom, historyControls, hint);
  let zoom = 1;
  let offset = { x: 0, y: 0 };
  let spaceHeld = false;
  let keyboardNavigation = false;
  let pan: { start: Point; offset: Point } | null = null;
  let hasFitted = false;
  const pagePoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = document.body.getBoundingClientRect();
    return { x: (event.clientX - rect.x) / zoom, y: (event.clientY - rect.y) / zoom };
  };
  const positionOf = (element: Element): Point => {
    const rect = element.getBoundingClientRect();
    return resolveDesignPosition(
      element.getAttribute("data-t3-design-x"),
      element.getAttribute("data-t3-design-y"),
      getComputedStyle(element).translate,
      rect.width / zoom,
      rect.height / zoom,
    );
  };

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  let tool: Tool = "hand";
  let selected: HTMLElement | SVGElement | null = null;
  let selectionElements: (HTMLElement | SVGElement)[] = [];
  let transformElements: {
    element: HTMLElement | SVGElement;
    before: ElementState;
    position: Point;
    rect: DOMRect;
  }[] = [];
  let marquee: { start: Point; previous: (HTMLElement | SVGElement)[]; additive: boolean } | null =
    null;
  const marqueeBox = document.createElement("div");
  marqueeBox.className = "hover";
  root.append(marqueeBox);
  const boundsOf = (elements: Element[]): DOMRect => {
    const rects = elements.map((element) => element.getBoundingClientRect());
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    return new window.DOMRect(
      left,
      top,
      Math.max(...rects.map((rect) => rect.right)) - left,
      Math.max(...rects.map((rect) => rect.bottom)) - top,
    );
  };
  const editableElements = (): (HTMLElement | SVGElement)[] =>
    [...document.body.querySelectorAll("*")].filter(
      (element): element is HTMLElement | SVGElement =>
        (element instanceof HTMLElement || element instanceof SVGElement) &&
        !["SCRIPT", "STYLE", "LINK", "META"].includes(element.tagName) &&
        element.getAttribute(OBJECT_ATTRIBUTE) !== "layer" &&
        !element.parentElement?.closest(
          `svg,[${OBJECT_ATTRIBUTE}]:not([${OBJECT_ATTRIBUTE}="layer"])`,
        ),
    );
  const groupOf = (element: Element): string | undefined =>
    element.getAttribute(GROUP_ATTRIBUTE)?.split(" ").at(-1);
  const groupMembers = (element: Element): Element[] => {
    const group = groupOf(element);
    return group
      ? [...document.querySelectorAll(`[${GROUP_ATTRIBUTE}~="${CSS.escape(group)}"]`)]
      : [element];
  };
  let drag: DragState | null = null;
  let activePointerId: number | null = null;
  let dragBatch: {
    index: number;
    history: HistoryEntry[];
    selection: (HTMLElement | SVGElement)[];
  } | null = null;
  let history: HistoryEntry[] = [];
  let historyIndex = 0;
  let saveTimer: number | null = null;
  let editorOpen = false;
  let panelOpen = false;
  const layerOpen = new Map<Element, boolean>();
  let statusTimer: number | null = null;
  let saveRevision = 0;

  const setStatus = (text: string, dirty = false): void => {
    if (statusTimer !== null) globalThis.window.clearTimeout(statusTimer);
    statusTimer = null;
    status.textContent = text;
    status.toggleAttribute("data-dirty", dirty);
  };

  const save = (annotation?: DesktopPreviewDesignChangePayload["annotation"]): void => {
    if (saveTimer !== null) globalThis.window.clearTimeout(saveTimer);
    saveTimer = null;
    const revision = ++saveRevision;
    const payload: DesktopPreviewDesignChangePayload = {
      html: serializeDesignDocument(document),
      ...(annotation ? { annotation } : {}),
    };
    setStatus(annotation ? "Attaching…" : "Saving…", true);
    void options.onChange(payload).then(
      () => {
        if (saveTimer !== null || revision !== saveRevision) return;
        setStatus(annotation ? "Attached to chat" : "Saved");
        statusTimer = globalThis.window.setTimeout(() => setStatus(""), 2000);
      },
      () => {
        if (revision === saveRevision) setStatus("Save failed · retry Save", true);
      },
    );
  };

  const scheduleSave = (): void => {
    if (saveTimer !== null) globalThis.window.clearTimeout(saveTimer);
    setStatus("Unsaved changes", true);
    saveTimer = globalThis.window.setTimeout(save, SAVE_DELAY_MS);
  };

  const flushSave = (): void => {
    if (saveTimer === null) return;
    globalThis.window.clearTimeout(saveTimer);
    save();
  };

  saveNow.addEventListener("click", () => {
    if (saveTimer !== null) globalThis.window.clearTimeout(saveTimer);
    save();
  });

  const refreshHistoryButtons = (): void => {
    undo.disabled = historyIndex === 0;
    redo.disabled = historyIndex === history.length;
  };

  const pushHistory = (entry: HistoryEntry): void => {
    history = [...history.slice(0, historyIndex), entry];
    historyIndex = history.length;
    refreshHistoryButtons();
  };

  const setFieldValue = (
    field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string,
  ): void => {
    if (root.activeElement === field) return;
    if (
      field instanceof HTMLSelectElement &&
      value &&
      !Array.from(field.options).some((option) => option.value === value)
    ) {
      field.add(new Option(value, value));
    }
    field.value = value;
  };

  const refreshSelection = (): void => {
    if (!editorOpen) {
      selection.style.display = "none";
      textToolbar.style.display = "none";
      return;
    }
    selectionElements = selectionElements.filter((element) => element.isConnected);
    selected = selectionElements.at(-1) ?? null;
    if (!selected?.isConnected) {
      selected = null;
      selection.style.display = "none";
      inspector.style.display = "none";
      selectionSection.hidden = true;
      emptyHint.hidden = false;
      hint.style.display = "";
      textToolbar.style.display = "none";
      attach.disabled = true;
      remove.disabled = true;
      choose.disabled = true;
      return;
    }
    const rect = boundsOf(selectionElements);
    selection.style.display = "block";
    selection.style.transform = `translate(${rect.left}px,${rect.top}px)`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
    selection.toggleAttribute("data-tag-below", rect.top < 30);
    const name =
      selected.getAttribute("data-t3-design-id") ??
      selected.getAttribute(OBJECT_ATTRIBUTE) ??
      selected.tagName.toLowerCase();
    tagName.textContent =
      selected.getAttribute("data-t3-design-artboard") ||
      selected.getAttribute("aria-label") ||
      (selected.childElementCount === 0 ? selected.textContent?.trim().slice(0, 40) : "") ||
      name;
    if (selectionElements.length > 1) tagName.textContent = `${selectionElements.length} elements`;
    tag.hidden = editingText !== null;
    for (const handle of selection.querySelectorAll<HTMLButtonElement>(".handle"))
      handle.hidden =
        editingText !== null ||
        tool === "hand" ||
        spaceHeld ||
        selectionElements.every((element) => element.hasAttribute(LOCK_ATTRIBUTE));
    tagSize.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    inspector.style.display = "block";
    selectionSection.hidden = false;
    emptyHint.hidden = true;
    hint.style.display = "none";
    inspectorName.textContent =
      selectionElements.length > 1 ? `${selectionElements.length} elements` : name;
    inspectorTag.textContent = selected.tagName.toLowerCase();
    remove.disabled = false;
    choose.disabled = false;
    attach.disabled = false;
    const computed = getComputedStyle(selected);
    const position = positionOf(selected);
    textValue.disabled = selectionElements.length > 1 || selected.childElementCount > 0;
    setFieldValue(textValue, selected.childElementCount === 0 ? (selected.textContent ?? "") : "");
    const fillValue = rgbToHex(computed.backgroundColor, "#ffffff");
    const colorValue = rgbToHex(computed.color, "#111111");
    const borderColorValue = rgbToHex(computed.borderColor, "#000000");
    setFieldValue(fill, fillValue);
    setFieldValue(fillText, computed.backgroundColor);
    setFieldValue(color, colorValue);
    setFieldValue(colorText, computed.color);
    for (const [property, input] of styleFields) {
      setFieldValue(input, computed.getPropertyValue(property));
    }
    setFieldValue(fontSize, String(Math.round(Number.parseFloat(computed.fontSize) || 16)));
    setFieldValue(width, String(Math.round(rect.width / zoom)));
    setFieldValue(height, String(Math.round(rect.height / zoom)));
    setFieldValue(xValue, String(Math.round(position.x)));
    setFieldValue(yValue, String(Math.round(position.y)));
    setFieldValue(positionMode, computed.position);
    setFieldValue(zIndex, computed.zIndex === "auto" ? "0" : computed.zIndex);
    setFieldValue(displayMode, computed.display);
    setFieldValue(direction, computed.flexDirection);
    setFieldValue(gap, String(Math.round(Number.parseFloat(computed.gap) || 0)));
    setFieldValue(align, computed.alignItems === "normal" ? "stretch" : computed.alignItems);
    setFieldValue(
      justify,
      computed.justifyContent === "normal" ? "start" : computed.justifyContent,
    );
    setFieldValue(wrap, computed.flexWrap);
    setFieldValue(padding, computed.padding);
    setFieldValue(margin, computed.margin);
    setFieldValue(radius, String(Math.round(Number.parseFloat(computed.borderRadius) || 0)));
    setFieldValue(overflow, computed.overflow);
    setFieldValue(opacity, String(Math.round(Number(computed.opacity) * 100)));
    setFieldValue(borderWidth, String(Math.round(Number.parseFloat(computed.borderWidth) || 0)));
    setFieldValue(borderStyle, computed.borderStyle);
    setFieldValue(borderColor, borderColorValue);
    setFieldValue(borderColorText, computed.borderColor);
    setFieldValue(boxShadow, computed.boxShadow === "none" ? "" : computed.boxShadow);
    const chosen = findArtboard(selected)?.hasAttribute(SELECTED_ATTRIBUTE) ?? false;
    if (choose.hasAttribute("data-chosen") !== chosen) {
      choose.toggleAttribute("data-chosen", chosen);
      choose.innerHTML = chosen ? `${svgIcon(ICONS.check)}Selected for build` : "Use this design";
    }
    if (editingText) positionTextToolbar();
  };

  function refreshLayers(): void {
    layers.replaceChildren();
    for (const element of selectionElements)
      for (
        let parent = element.parentElement;
        parent && parent !== document.body;
        parent = parent.parentElement
      )
        layerOpen.set(parent, true);
    let count = 0;
    const append = (element: Element, depth: number): void => {
      if (count >= 160 || ["SCRIPT", "STYLE", "LINK", "META"].includes(element.tagName)) return;
      if (element.getAttribute(OBJECT_ATTRIBUTE) === "layer") {
        for (const child of element.children) append(child, depth);
        return;
      }
      count += 1;
      const open = layerOpen.get(element) ?? depth === 0;
      const line = document.createElement("div");
      line.className = "layer-row";
      line.style.paddingLeft = `${4 + Math.min(depth, 6) * 12}px`;
      if (element.childElementCount) {
        const chevron = button(
          open ? "▾" : "▸",
          () => {
            layerOpen.set(element, !open);
            refreshLayers();
          },
          line,
        );
        chevron.className = "layer-chevron";
        chevron.setAttribute("aria-label", open ? "Collapse children" : "Expand children");
      } else {
        const spacer = document.createElement("span");
        spacer.className = "layer-spacer";
        line.appendChild(spacer);
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "layer";
      const artboard = element.getAttribute("data-t3-design-artboard");
      const id = element.getAttribute("data-t3-design-id") || element.id;
      const text =
        element.childElementCount === 0
          ? element.textContent?.trim().replace(/\s+/g, " ").slice(0, 28)
          : null;
      const label = document.createElement("span");
      label.textContent =
        artboard ||
        id ||
        (element.hasAttribute("data-t3-design-artboard") ? "Artboard" : text) ||
        element.tagName.toLowerCase();
      if (element.hasAttribute(LOCK_ATTRIBUTE)) label.textContent += " · Locked";
      if (getComputedStyle(element).visibility === "hidden") label.textContent += " · Hidden";
      const kind = document.createElement("span");
      kind.className = "layer-tag";
      kind.textContent = element.tagName.toLowerCase();
      row.append(label, kind);
      row.title = `${element.tagName.toLowerCase()}${id ? ` · ${id}` : ""}`;
      row.setAttribute(
        "aria-selected",
        String(selectionElements.includes(element as HTMLElement | SVGElement)),
      );
      row.addEventListener("click", (event) =>
        selectElement(element, true, event.shiftKey, event.ctrlKey || event.metaKey),
      );
      line.appendChild(row);
      layers.appendChild(line);
      if (!open) return;
      for (const child of element.children) append(child, depth + 1);
    };
    for (const element of document.body.children) append(element, 0);
  }

  const selectElements = (elements: Element[], persist = true): void => {
    document
      .querySelectorAll(`[${FOCUS_ATTRIBUTE}]`)
      .forEach((element) => element.removeAttribute(FOCUS_ATTRIBUTE));
    selectionElements = [...new Set(elements)].filter(
      (element): element is HTMLElement | SVGElement =>
        (element instanceof HTMLElement || element instanceof SVGElement) &&
        element.isConnected &&
        !elements.some((other) => other !== element && other.contains(element)),
    );
    selected = selectionElements.at(-1) ?? null;
    for (const element of selectionElements) {
      const id = element.getAttribute("data-t3-design-id");
      if (!id || document.querySelectorAll(`[data-t3-design-id="${CSS.escape(id)}"]`).length > 1)
        element.setAttribute("data-t3-design-id", nextId());
      element.setAttribute(FOCUS_ATTRIBUTE, "true");
    }
    refreshSelection();
    refreshLayers();
    if (persist) scheduleSave();
  };
  const selectElement = (
    element: Element | null,
    persist = true,
    toggle = false,
    direct = false,
  ): void => {
    const elements = element ? (direct ? [element] : groupMembers(element)) : [];
    selectElements(
      toggle
        ? elements.some((item) => selectionElements.includes(item as HTMLElement | SVGElement))
          ? selectionElements.filter((item) => !elements.includes(item))
          : [
              ...selectionElements.filter(
                (item) => !elements.some((other) => item.contains(other)),
              ),
              ...elements,
            ]
        : elements,
      persist,
    );
  };
  const batch = (action: () => void): void => {
    const index = historyIndex;
    const before = [...selectionElements];
    action();
    recordBatch(index, before);
  };
  const recordBatch = (index: number, before: (HTMLElement | SVGElement)[]): void => {
    if (historyIndex === index) return;
    const entries = history.slice(index, historyIndex);
    const after = [...selectionElements];
    history = history.slice(0, index);
    historyIndex = index;
    pushHistory({
      undo: () => {
        for (let index = entries.length - 1; index >= 0; index -= 1) entries[index]!.undo();
        selectElements(before);
      },
      redo: () => {
        for (const entry of entries) entry.redo();
        selectElements(after);
      },
    });
    refreshLayers();
    scheduleSave();
  };

  const attachSelection = (): void => {
    if (!selected) return;
    const annotations = selectionElements.map((element) => {
      const id = element.getAttribute("data-t3-design-id")!;
      const rect = element.getBoundingClientRect();
      return createDesignSelectionAnnotation({
        id,
        pageUrl: options.url,
        pageTitle: document.title?.trim() || null,
        tagName: element.tagName.toLowerCase(),
        selector: `[data-t3-design-id="${CSS.escape(id)}"]`,
        htmlPreview: element.outerHTML.slice(0, 4_000),
        styles: element.getAttribute("style") ?? "",
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        createdAt: new Date().toISOString(),
      });
    });
    if (saveTimer !== null) globalThis.window.clearTimeout(saveTimer);
    save({
      ...annotations[0]!,
      id: annotations.map((annotation) => annotation.id).join("-"),
      elements: annotations.flatMap((annotation) => annotation.elements),
    });
  };

  const commitElementState = (element: HTMLElement | SVGElement, before: ElementState): void => {
    const after = stateOf(element);
    if (statesMatch(before, after)) return;
    pushHistory({
      undo: () => applyState(element, before),
      redo: () => applyState(element, after),
    });
  };

  const runHistory = (direction: -1 | 1): void => {
    const entry = direction < 0 ? history[historyIndex - 1] : history[historyIndex];
    if (!entry) return;
    if (direction < 0) {
      historyIndex -= 1;
      entry.undo();
    } else {
      entry.redo();
      historyIndex += 1;
    }
    refreshHistoryButtons();
    refreshSelection();
    refreshLayers();
    scheduleSave();
  };

  const button = (
    label: string,
    action: () => void,
    parent: HTMLElement | ShadowRoot,
  ): HTMLButtonElement => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", action);
    parent.appendChild(element);
    return element;
  };

  const iconButton = (label: string, icon: string, action: () => void): HTMLButtonElement => {
    const element = button("", action, editTools);
    element.title = label;
    element.setAttribute("aria-label", label);
    element.innerHTML = svgIcon(icon);
    return element;
  };

  const zoomLabel = document.createElement("summary");
  zoomLabel.setAttribute("aria-label", "Zoom options");
  const updateCursor = (): void => {
    document.documentElement.style.setProperty(
      "--t3-canvas-cursor",
      pan
        ? "grabbing"
        : spaceHeld || tool === "hand"
          ? "grab"
          : tool === "select"
            ? "default"
            : "crosshair",
    );
  };
  const renderViewport = (): void => {
    document.documentElement.style.setProperty("--t3-canvas-x", `${offset.x}px`);
    document.documentElement.style.setProperty("--t3-canvas-y", `${offset.y}px`);
    document.documentElement.style.setProperty("--t3-canvas-zoom", String(zoom));
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    hover.style.display = "none";
    refreshSelection();
  };
  const setZoom = (
    next: number,
    point = { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  ): void => {
    const previous = zoom;
    const body = document.body.getBoundingClientRect();
    const origin = { x: body.left - offset.x, y: body.top - offset.y };
    zoom = Math.max(0.02, Math.min(4, next));
    offset = {
      x: point.x - origin.x - ((point.x - origin.x - offset.x) * zoom) / previous,
      y: point.y - origin.y - ((point.y - origin.y - offset.y) * zoom) / previous,
    };
    renderViewport();
  };
  const fitCanvas = (elements?: Element[]): void => {
    const boards = [...document.querySelectorAll(ARTBOARD_SELECTOR)];
    const targets = elements ?? [
      ...(boards.length ? boards : [document.body]),
      ...document.querySelectorAll(`[${OBJECT_ATTRIBUTE}]:not([${OBJECT_ATTRIBUTE}="layer"])`),
    ];
    const rects = targets.map((element) => element.getBoundingClientRect());
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const width = Math.max(...rects.map((rect) => rect.right)) - left;
    const height = Math.max(...rects.map((rect) => rect.bottom)) - top;
    const insetLeft = 32;
    const insetRight = toolbar.hidden ? 32 : 280;
    const insetTop = 96;
    const availableWidth = Math.max(80, window.innerWidth - insetLeft - insetRight);
    const availableHeight = Math.max(80, window.innerHeight - insetTop - 72);
    setZoom(
      zoom * Math.min(availableWidth / Math.max(width, 1), availableHeight / Math.max(height, 1)),
      { x: left, y: top },
    );
    offset.x += insetLeft - left;
    offset.y += insetTop - top;
    renderViewport();
  };
  button("−", () => setZoom(zoom / 1.2), bottom).setAttribute("aria-label", "Zoom out");
  const zoomMenu = document.createElement("details");
  zoomMenu.className = "zoom-menu";
  const zoomOptions = document.createElement("div");
  zoomOptions.className = "menu-options";
  zoomMenu.append(zoomLabel, zoomOptions);
  bottom.append(zoomMenu);
  button("+", () => setZoom(zoom * 1.2), bottom).setAttribute("aria-label", "Zoom in");
  button(
    "Fit all designs",
    () => {
      fitCanvas();
      zoomMenu.open = false;
    },
    zoomOptions,
  );
  for (const value of [0.25, 0.5, 1, 2])
    button(
      `${value * 100}%`,
      () => {
        setZoom(value);
        zoomMenu.open = false;
      },
      zoomOptions,
    );
  zoomLabel.textContent = "100%";
  const editToggle = button("", () => setPanelOpen(!panelOpen), topActions);
  const setPanelOpen = (open: boolean): void => {
    panelOpen = open;
    toolbar.hidden = !open;
    editToggle.setAttribute("aria-pressed", String(open));
    if (open && window.innerWidth <= 600) selectElement(null, false);
  };
  editToggle.className = "edit";
  editToggle.innerHTML = `${svgIcon(ICONS.draw)}Edit`;
  editToggle.title = "Edit the selected element";
  editToggle.setAttribute("aria-pressed", "false");
  topActions.append(saveNow);
  button("×", () => setPanelOpen(false), panelHeader).setAttribute(
    "aria-label",
    "Close properties",
  );
  const canvasMenu = document.createElement("details");
  canvasMenu.className = "canvas-menu";
  const menuTitle = document.createElement("summary");
  menuTitle.setAttribute("aria-label", "Canvas menu");
  menuTitle.innerHTML = svgIcon('<path d="M4 6h16M4 12h16M4 18h16"/>');
  const menuOptions = document.createElement("div");
  menuOptions.className = "menu-options";
  canvasMenu.append(menuTitle, menuOptions);
  const topBar = document.createElement("div");
  topBar.className = "top-bar";
  const toolGroup = document.createElement("div");
  toolGroup.className = "tool-group";
  toolGroup.append(editTools, hint);
  topBar.append(canvasMenu, toolGroup, topActions);
  root.append(topBar);
  button(
    "Export HTML",
    () => {
      const url = URL.createObjectURL(
        new Blob([serializeDesignDocument(document)], { type: "text/html" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "design.html";
      link.click();
      globalThis.window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      canvasMenu.open = false;
    },
    menuOptions,
  );
  button(
    "Print / PDF",
    () => {
      canvasMenu.open = false;
      window.print();
    },
    menuOptions,
  );
  const help = document.createElement("dialog");
  help.className = "canvas-help";
  help.setAttribute("aria-label", "Keyboard shortcuts");
  help.innerHTML =
    "<h2>Keyboard shortcuts</h2><dl>" +
    [
      ["Pan", "H / Space + drag / middle drag"],
      ["Select", "V / 1"],
      ["Rectangle", "R / B / 2"],
      ["Diamond", "D / 3"],
      ["Ellipse", "O / C / 4"],
      ["Arrow / Line / Draw", "A / L / P or 5 / 6 / 7"],
      ["Highlight", "Shift + H"],
      ["Add text / note", "T or 8 / N"],
      ["Edit text", "Enter / double-click"],
      ["Finish text", "Escape / Ctrl or ⌘ + Enter"],
      ["Multi-select", "Shift + click / drag empty canvas"],
      ["Select all", "Ctrl / ⌘ + A"],
      ["Next / previous element", "Tab / Shift + Tab"],
      ["Distribute horizontally / vertically", "Ctrl / ⌘ + Alt + H / V"],
      ["Group / ungroup", "Ctrl / ⌘ + G / Shift + G"],
      ["Select inside group", "Ctrl / ⌘ + click"],
      ["Duplicate", "Ctrl / ⌘ + D / Alt + drag"],
      ["Lock / unlock", "Ctrl / ⌘ + Shift + L"],
      ["Hide / show", "Ctrl / ⌘ + Shift + H"],
      ["Layer order / front or back", "Ctrl / ⌘ + [ or ] / add Shift"],
      ["Align left / center / right", "Alt + A / H / D"],
      ["Align top / center / bottom", "Alt + W / V / S"],
      ["Constrain shape / move / resize", "Hold Shift while dragging"],
      ["Bold / italic / underline text", "Ctrl / ⌘ + B / I / U"],
      ["Copy / Cut / Paste", "Ctrl / ⌘ + C / X / V"],
      ["Delete", "Delete / Backspace"],
      ["Move / move 10 px", "Arrow keys / Shift + arrows"],
      ["Undo", "Ctrl / ⌘ + Z"],
      ["Redo", "Ctrl / ⌘ + Shift + Z or Y"],
      ["Save", "Ctrl / ⌘ + S"],
      ["Zoom", "Ctrl / ⌘ + plus / minus / scroll"],
      ["Reset zoom", "Ctrl / ⌘ + 0"],
      ["Fit all / selection", "Shift + 1 / 2"],
      ["Cancel / deselect", "Escape"],
      ["Shortcuts", "?"],
    ]
      .map(([label, keys]) => `<dt>${label}</dt><dd>${keys}</dd>`)
      .join("") +
    "</dl>";
  const closeHelp = button("×", () => help.close(), help);
  closeHelp.className = "close";
  closeHelp.setAttribute("aria-label", "Close keyboard shortcuts");
  const helpButton = button("?", () => help.showModal(), root);
  helpButton.className = "help-button";
  helpButton.setAttribute("aria-label", "Help");
  root.append(help, helpButton);
  window.addEventListener(
    "wheel",
    (event) => {
      if (!editorOpen || annotationActive() || isUiElement(event.target) || editingText) return;
      event.preventDefault();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? window.innerHeight
            : 1;
      if (event.ctrlKey || event.metaKey)
        setZoom(zoom * Math.exp(-event.deltaY * unit * 0.01), {
          x: event.clientX,
          y: event.clientY,
        });
      else {
        offset.x -= event.deltaX * unit;
        offset.y -= event.deltaY * unit;
        renderViewport();
      }
    },
    { passive: false },
  );
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      spaceHeld = false;
      updateCursor();
      refreshSelection();
    }
  });
  window.addEventListener("blur", () => {
    spaceHeld = false;
    pan = null;
    updateCursor();
    cancelDrag();
  });
  const closeMenus = (event: Event) => {
    for (const menu of [zoomMenu, canvasMenu])
      if (!event.composedPath().includes(menu)) menu.open = false;
  };
  root.addEventListener("pointerdown", closeMenus);
  window.addEventListener("pointerdown", (event) => {
    if (event.target !== host) closeMenus(event);
  });

  const setTool = (next: Tool): void => {
    tool = next;
    for (const [candidate, element] of toolButtons) {
      element.setAttribute("aria-pressed", String(candidate === tool));
    }
    updateCursor();
    refreshSelection();
    if (tool !== "select") hover.style.display = "none";
  };

  for (const [value, label, icon] of [
    [
      "hand",
      "Hand (H)",
      '<path d="M8 13V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v9c0 4-3 7-7 7h-1c-2 0-4-1-5-3l-4-6a2 2 0 0 1 3-2l2 2Z"/>',
    ],
    ["select", "Select (V)", ICONS.select],
    ["box", "Rectangle (R)", ICONS.box],
    ["diamond", "Diamond (D)", '<path d="m12 3 9 9-9 9-9-9Z"/>'],
    ["circle", "Ellipse (O)", ICONS.circle],
    ["arrow", "Arrow (A)", ICONS.arrow],
    ["line", "Line (L)", '<path d="m4 20 16-16"/>'],
    ["draw", "Draw (P)", ICONS.draw],
    ["highlight", "Highlight (Shift+H)", ICONS.highlight],
  ] as const) {
    const element = iconButton(label, icon, () => setTool(value));
    element.setAttribute("aria-pressed", "false");
    const shortcut = document.createElement("span");
    shortcut.className = "shortcut";
    shortcut.textContent = label.match(/\((.)\)/)?.[1] ?? "";
    element.append(shortcut);
    toolButtons.set(value, element);
  }

  const attach = button("Add to chat", attachSelection, actions);
  topActions.append(attach);
  attach.className = "attach";
  attach.innerHTML = `${svgIcon(ICONS.attach)}Add to chat`;
  attach.title = "Add the selected element to your chat draft";
  const undo = button("", () => runHistory(-1), actions);
  undo.innerHTML = svgIcon(ICONS.undo);
  undo.title = "Undo (⌘Z)";
  undo.setAttribute("aria-label", "Undo");
  historyControls.append(undo);
  const redo = button("", () => runHistory(1), historyControls);
  redo.innerHTML = svgIcon(ICONS.redo);
  redo.title = "Redo (⇧⌘Z)";
  redo.setAttribute("aria-label", "Redo");

  const designLayer = (): HTMLDivElement => {
    let layer = document.querySelector<HTMLDivElement>(`[${OBJECT_ATTRIBUTE}="layer"]`);
    if (!layer) {
      layer = document.createElement("div");
      layer.setAttribute(OBJECT_ATTRIBUTE, "layer");
      layer.setAttribute("data-t3-design-id", nextId());
      layer.style.cssText =
        "position:absolute;inset:0 0 auto 0;min-height:100%;pointer-events:none;z-index:2147483000";
      document.body.appendChild(layer);
    }
    layer.style.height = `${Math.max(document.body.scrollHeight, window.innerHeight / zoom)}px`;
    return layer;
  };

  const addObject = (element: HTMLElement | SVGElement): void => {
    const layer = designLayer();
    layer.appendChild(element);
    pushHistory({
      undo: () => element.remove(),
      redo: () => layer.appendChild(element),
    });
    selectElement(element);
  };

  const baseObject = (kind: string, x: number, y: number): HTMLDivElement => {
    const element = document.createElement("div");
    element.setAttribute(OBJECT_ATTRIBUTE, kind);
    element.setAttribute("data-t3-design-id", nextId());
    element.style.cssText = `position:absolute;left:${x}px;top:${y}px;pointer-events:auto;box-sizing:border-box`;
    return element;
  };

  const addText = (note = false, text?: string): void => {
    const { x, y } = pagePoint({
      clientX: window.innerWidth / 2 - 90,
      clientY: window.innerHeight / 2 - 40,
    });
    const element = baseObject(note ? "note" : "text", x, y);
    element.textContent = text ?? (note ? "Add a note" : "Edit text");
    element.style.cssText += note
      ? ";width:180px;min-height:90px;padding:14px;border-radius:10px;background:#fef08a;color:#422006;box-shadow:0 8px 20px rgba(0,0,0,.15)"
      : ";padding:6px 8px;color:#111;font:600 18px/1.3 system-ui;background:transparent;white-space:pre-wrap";
    addObject(element);
  };

  iconButton("Add text (T)", ICONS.text, () => addText());
  iconButton("Add note (N)", ICONS.note, () => addText(true));

  const findArtboard = (element: Element): Element | null => {
    const marked = element.closest(ARTBOARD_SELECTOR);
    if (marked) return marked;
    let candidate = element;
    while (candidate.parentElement && candidate.parentElement !== document.body) {
      candidate = candidate.parentElement;
    }
    return candidate.hasAttribute(OBJECT_ATTRIBUTE) ? null : candidate;
  };

  const designChoice = document.createElement("div");
  designChoice.className = "design-choice";
  actions.append(designChoice);
  const choose = button(
    "Use this design",
    () => {
      if (!selected) return;
      const artboard = findArtboard(selected);
      if (!artboard) return;
      const previous = document.querySelector(`[${SELECTED_ATTRIBUTE}]`);
      if (previous === artboard) return;
      const apply = (choice: Element | null): void => {
        document
          .querySelectorAll(`[${SELECTED_ATTRIBUTE}]`)
          .forEach((element) => element.removeAttribute(SELECTED_ATTRIBUTE));
        choice?.setAttribute(SELECTED_ATTRIBUTE, "true");
      };
      apply(artboard);
      pushHistory({ undo: () => apply(previous), redo: () => apply(artboard) });
      refreshSelection();
      scheduleSave();
    },
    designChoice,
  );
  choose.className = "choose";
  choose.title = "Mark this design for the agent to build";
  const choiceDescription = document.createElement("p");
  choiceDescription.id = "design-choice-description";
  choiceDescription.textContent = "Saves this choice for the agent to build.";
  choose.setAttribute("aria-describedby", choiceDescription.id);
  designChoice.append(choiceDescription);

  const remove = button(
    "",
    () => {
      batch(() => {
        for (const element of selectionElements) {
          if (element.hasAttribute(LOCK_ATTRIBUTE)) continue;
          const parent = element.parentNode;
          if (!parent) continue;
          const next = element.nextSibling;
          element.remove();
          pushHistory({
            undo: () => parent.insertBefore(element, next?.parentNode === parent ? next : null),
            redo: () => element.remove(),
          });
        }
        selectElements([]);
      });
    },
    actions,
  );
  remove.className = "delete";
  remove.innerHTML = svgIcon(ICONS.trash);
  remove.title = "Delete (⌫)";
  remove.setAttribute("aria-label", "Delete");

  const duplicateElement = (
    source: HTMLElement | SVGElement,
    parent = source.parentElement,
    next = source.nextSibling,
    groups = new Map<string, string>(),
  ): HTMLElement | SVGElement | null => {
    if (!parent?.isConnected) return null;
    const clone = source.cloneNode(true) as HTMLElement | SVGElement;
    parent.insertBefore(clone, next?.parentNode === parent ? next : null);
    const elements = [clone, ...clone.querySelectorAll<HTMLElement | SVGElement>("*")];
    const styles = elements.map((element) => {
      const computed = getComputedStyle(element);
      return [...computed].map(
        (property) => [property, computed.getPropertyValue(property)] as const,
      );
    });
    const ids = new Map<string, string>();
    for (const element of elements) {
      if (element.id) {
        const id = nextId();
        ids.set(element.id, id);
        element.id = id;
      }
      if (element.hasAttribute("data-t3-design-id"))
        element.setAttribute("data-t3-design-id", nextId());
      const groupIds = element.getAttribute(GROUP_ATTRIBUTE)?.split(" ");
      if (groupIds)
        element.setAttribute(
          GROUP_ATTRIBUTE,
          groupIds
            .map((id) => {
              if (!groups.has(id)) groups.set(id, nextId());
              return groups.get(id)!;
            })
            .join(" "),
        );
      element.removeAttribute(FOCUS_ATTRIBUTE);
      element.removeAttribute(SELECTED_ATTRIBUTE);
    }
    for (const [index, element] of elements.entries()) {
      for (const attribute of element.attributes) {
        if (
          [
            "for",
            "list",
            "form",
            "headers",
            "aria-labelledby",
            "aria-describedby",
            "aria-controls",
            "aria-owns",
          ].includes(attribute.name)
        )
          attribute.value = attribute.value
            .split(/\s+/)
            .map((id) => ids.get(id) ?? id)
            .join(" ");
        else if (["href", "xlink:href"].includes(attribute.name) && attribute.value.startsWith("#"))
          attribute.value = `#${ids.get(attribute.value.slice(1)) ?? attribute.value.slice(1)}`;
        else
          attribute.value = attribute.value.replace(
            /url\(["']?#([^"')]+)["']?\)/g,
            (value, id: string) => (ids.has(id) ? `url(#${ids.get(id)})` : value),
          );
      }
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
      const computed = getComputedStyle(element);
      for (const [property, value] of styles[index]!)
        if (computed.getPropertyValue(property) !== value && !value.includes("url("))
          element.style.setProperty(property, value);
    }
    pushHistory({
      undo: () => clone.remove(),
      redo: () => parent.insertBefore(clone, next?.parentNode === parent ? next : null),
    });
    return clone;
  };
  const duplicateSelection = (offsetClones = true): void =>
    batch(() => {
      const groups = new Map<string, string>();
      const clones = selectionElements
        .map((element) =>
          duplicateElement(element, element.parentElement, element.nextSibling, groups),
        )
        .filter((element) => element !== null);
      for (const clone of clones)
        if (offsetClones && ["absolute", "fixed"].includes(getComputedStyle(clone).position)) {
          const position = positionOf(clone);
          clone.style.translate = `${position.x + 16}px ${position.y + 16}px`;
          clone.setAttribute("data-t3-design-x", String(position.x + 16));
          clone.setAttribute("data-t3-design-y", String(position.y + 16));
        }
      selectElements(clones);
    });
  button("Duplicate", () => duplicateSelection(), actions).title = "Duplicate (Ctrl / ⌘ + D)";

  const section = (title: string): HTMLElement => {
    const element = document.createElement("section");
    element.className = "section";
    const heading = document.createElement("h2");
    heading.className = "section-title";
    heading.textContent = title;
    element.appendChild(heading);
    inspector.appendChild(element);
    return element;
  };

  function field(label: string, input: HTMLElement, parent: HTMLElement): void {
    const wrapper = document.createElement("label");
    wrapper.className = "field";
    const name = document.createElement("span");
    name.textContent = label;
    input.setAttribute("aria-label", label);
    for (const control of input.querySelectorAll("input")) {
      control.setAttribute("aria-label", control.type === "color" ? `${label} picker` : label);
    }
    wrapper.append(name, input);
    parent.appendChild(wrapper);
  }

  const select = (values: ReadonlyArray<string>): HTMLSelectElement => {
    const input = document.createElement("select");
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      input.appendChild(option);
    }
    return input;
  };

  const colorControl = (picker: HTMLInputElement, text: HTMLInputElement): HTMLDivElement => {
    const control = document.createElement("div");
    control.className = "color-control";
    picker.type = "color";
    text.type = "text";
    control.append(picker, text);
    return control;
  };

  const textValue = document.createElement("textarea");
  const fill = document.createElement("input");
  const fillText = document.createElement("input");
  const color = document.createElement("input");
  const colorText = document.createElement("input");
  const fontSize = document.createElement("input");
  const width = document.createElement("input");
  const height = document.createElement("input");
  const xValue = document.createElement("input");
  const yValue = document.createElement("input");
  const positionMode = select(["static", "relative", "absolute", "fixed"]);
  const zIndex = document.createElement("input");
  const displayMode = select(["block", "flex", "grid", "inline-flex", "inline", "none"]);
  const direction = select(["row", "column", "row-reverse", "column-reverse"]);
  const gap = document.createElement("input");
  const align = select(["stretch", "start", "center", "end", "baseline"]);
  const justify = select(["start", "center", "end", "space-between", "space-around"]);
  const wrap = select(["nowrap", "wrap", "wrap-reverse"]);
  const padding = document.createElement("input");
  const margin = document.createElement("input");
  const radius = document.createElement("input");
  const overflow = select(["visible", "hidden", "clip", "auto", "scroll"]);
  const opacity = document.createElement("input");
  const borderWidth = document.createElement("input");
  const borderStyle = select(["none", "solid", "dashed", "dotted"]);
  const borderColor = document.createElement("input");
  const borderColorText = document.createElement("input");
  const boxShadow = document.createElement("input");
  for (const input of [
    fontSize,
    width,
    height,
    xValue,
    yValue,
    zIndex,
    gap,
    radius,
    opacity,
    borderWidth,
  ])
    input.type = "number";
  opacity.min = "0";
  opacity.max = "100";
  opacity.step = "1";
  const contentSection = section("Content");
  field("Text", textValue, contentSection);
  field("Text color", colorControl(color, colorText), contentSection);
  field("Font size", fontSize, contentSection);
  const styleFields = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const styleField = (label: string, property: string, parent: HTMLElement, values?: string[]) => {
    const input = values ? select(values) : document.createElement("input");
    if (input instanceof window.HTMLInputElement) input.type = "text";
    styleFields.set(property, input);
    field(label, input, parent);
  };
  styleField("Font", "font-family", contentSection);
  styleField("Weight", "font-weight", contentSection, [
    "100",
    "200",
    "300",
    "400",
    "500",
    "600",
    "700",
    "800",
    "900",
  ]);
  styleField("Style", "font-style", contentSection, ["normal", "italic", "oblique"]);
  styleField("Align", "text-align", contentSection, ["start", "center", "end", "justify"]);
  styleField("Line height", "line-height", contentSection);
  styleField("Tracking", "letter-spacing", contentSection);
  styleField("Case", "text-transform", contentSection, [
    "none",
    "uppercase",
    "lowercase",
    "capitalize",
  ]);
  styleField("Decoration", "text-decoration-line", contentSection, [
    "none",
    "underline",
    "line-through",
    "overline",
  ]);
  const sizingSection = section("Sizing");
  field("Width", width, sizingSection);
  field("Height", height, sizingSection);
  const positionSection = section("Position");
  field("Mode", positionMode, positionSection);
  field("X", xValue, positionSection);
  field("Y", yValue, positionSection);
  field("Z-index", zIndex, positionSection);
  styleField("Rotation", "rotate", positionSection);
  const layoutSection = section("Content layout");
  field("Layout", displayMode, layoutSection);
  field("Direction", direction, layoutSection);
  field("Gap", gap, layoutSection);
  field("Align", align, layoutSection);
  field("Justify", justify, layoutSection);
  field("Wrap", wrap, layoutSection);
  field("Padding", padding, layoutSection);
  field("Margin", margin, layoutSection);
  styleField("Columns", "grid-template-columns", layoutSection);
  styleField("Rows", "grid-template-rows", layoutSection);
  styleField("Grow", "flex-grow", layoutSection);
  styleField("Shrink", "flex-shrink", layoutSection);
  const appearanceSection = section("Appearance");
  field("Background", colorControl(fill, fillText), appearanceSection);
  field("Radius", radius, appearanceSection);
  field("Overflow", overflow, appearanceSection);
  field("Opacity %", opacity, appearanceSection);
  styleField("Image fit", "object-fit", appearanceSection, [
    "fill",
    "contain",
    "cover",
    "none",
    "scale-down",
  ]);
  const strokeSection = section("Drawing");
  styleField("Fill", "--t3-design-fill", strokeSection);
  styleField("Stroke", "--t3-design-stroke", strokeSection);
  styleField("Width", "--t3-design-stroke-width", strokeSection);
  styleField("Dashes", "--t3-design-stroke-dasharray", strokeSection);
  const borderSection = section("Border");
  field("Width", borderWidth, borderSection);
  field("Style", borderStyle, borderSection);
  field("Color", colorControl(borderColor, borderColorText), borderSection);
  const advancedSection = section("Advanced");
  boxShadow.type = "text";
  field("Shadow", boxShadow, advancedSection);
  const exportSection = section("Export selection");
  const exportSelection = document.createElement("button");
  exportSelection.type = "button";
  exportSelection.textContent = "Copy HTML";
  exportSection.appendChild(exportSelection);
  for (const group of [
    sizingSection,
    positionSection,
    layoutSection,
    appearanceSection,
    strokeSection,
    borderSection,
    advancedSection,
    exportSection,
  ]) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const heading = group.querySelector("h2");
    summary.textContent = heading?.textContent ?? "Options";
    heading?.remove();
    details.open = group === appearanceSection;
    details.append(summary, group);
    inspector.append(details);
  }
  for (const [label, input, section, colors] of [
    ["Text color", color, contentSection, ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"]],
    [
      "Background",
      fillText,
      appearanceSection,
      ["#ffffff", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"],
    ],
  ] as const) {
    const swatches = document.createElement("div");
    swatches.className = "swatches";
    for (const value of colors) {
      const swatch = button(
        "",
        () => {
          input.focus();
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.blur();
        },
        swatches,
      );
      swatch.style.backgroundColor = value;
      swatch.title = `${label} ${value}`;
      swatch.setAttribute("aria-label", `${label} ${value}`);
    }
    section.prepend(swatches);
  }

  const bindField = (
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    update: (element: HTMLElement | SVGElement, value: string) => void,
  ): void => {
    let targets: {
      element: HTMLElement | SVGElement;
      before: ElementState;
      rect: DOMRect;
      position: Point;
    }[] = [];
    let bounds: DOMRect;
    let origin: Point;
    input.addEventListener("focus", () => {
      targets = selectionElements
        .filter((element) => !element.hasAttribute(LOCK_ATTRIBUTE))
        .map((element) => ({
          element,
          before: stateOf(element),
          rect: element.getBoundingClientRect(),
          position: positionOf(element),
        }));
      bounds = boundsOf(selectionElements);
      origin = selected ? positionOf(selected) : { x: 0, y: 0 };
    });
    input.addEventListener("input", () => {
      for (const { element, rect, position } of targets) {
        if (!selectionElements.includes(element)) continue;
        if (
          targets.length > 1 &&
          [width, height, xValue, yValue].includes(input as HTMLInputElement)
        ) {
          const value = Number(input.value);
          if (!input.value.trim() || !Number.isFinite(value)) continue;
          if (input === width || input === height) {
            if (value <= 0) continue;
            const horizontal = input === width;
            const length = (horizontal ? bounds.width : bounds.height) / zoom;
            if (length === 0) continue;
            const scale = value / length;
            update(element, String(((horizontal ? rect.width : rect.height) / zoom) * scale));
            const x =
              position.x + (horizontal ? ((rect.left - bounds.left) / zoom) * (scale - 1) : 0);
            const y =
              position.y + (horizontal ? 0 : ((rect.top - bounds.top) / zoom) * (scale - 1));
            element.style.translate = `${x}px ${y}px`;
            element.setAttribute("data-t3-design-x", String(x));
            element.setAttribute("data-t3-design-y", String(y));
          } else
            update(
              element,
              String(
                (input === xValue ? position.x : position.y) +
                  value -
                  (input === xValue ? origin.x : origin.y),
              ),
            );
        } else update(element, input.value);
      }
      refreshSelection();
      scheduleSave();
    });
    input.addEventListener("change", () => {
      batch(() => {
        for (const target of targets) {
          commitElementState(target.element, target.before);
          target.before = stateOf(target.element);
        }
      });
    });
    input.addEventListener("blur", () => {
      targets = [];
    });
  };

  for (const [property, input] of styleFields) {
    bindField(input, (element, value) => element.style.setProperty(property, value));
  }
  bindField(textValue, (element, value) => {
    if (element.childElementCount === 0) element.textContent = value;
  });
  bindField(fill, (element, value) => {
    const next = designColorWithAlpha(value, getComputedStyle(element).backgroundColor);
    fillText.value = next;
    element.style.setProperty("background-color", next);
  });
  bindField(fillText, (element, value) => {
    if (/^#[0-9a-f]{6}$/i.test(value)) fill.value = value;
    element.style.setProperty("background-color", value);
  });
  bindField(color, (element, value) => {
    const next = designColorWithAlpha(value, getComputedStyle(element).color);
    colorText.value = next;
    element.style.setProperty("color", next);
  });
  bindField(colorText, (element, value) => {
    if (/^#[0-9a-f]{6}$/i.test(value)) color.value = value;
    element.style.setProperty("color", value);
  });
  bindField(fontSize, (element, value) => element.style.setProperty("font-size", `${value}px`));
  bindField(width, (element, value) => {
    element.style.setProperty("min-width", "0");
    element.style.setProperty("max-width", "none");
    element.style.setProperty("width", `${value}px`);
  });
  bindField(height, (element, value) => {
    element.style.setProperty("min-height", "0");
    element.style.setProperty("max-height", "none");
    element.style.setProperty("height", `${value}px`);
  });
  bindField(xValue, (element, value) => {
    const y = positionOf(element).y;
    element.style.translate = `${value}px ${y}px`;
    element.setAttribute("data-t3-design-x", value);
  });
  bindField(yValue, (element, value) => {
    const x = positionOf(element).x;
    element.style.translate = `${x}px ${value}px`;
    element.setAttribute("data-t3-design-y", value);
  });
  bindField(positionMode, (element, value) => element.style.setProperty("position", value));
  bindField(zIndex, (element, value) => element.style.setProperty("z-index", value));
  bindField(displayMode, (element, value) => element.style.setProperty("display", value));
  bindField(direction, (element, value) => element.style.setProperty("flex-direction", value));
  bindField(gap, (element, value) => element.style.setProperty("gap", `${value}px`));
  bindField(align, (element, value) => element.style.setProperty("align-items", value));
  bindField(justify, (element, value) => element.style.setProperty("justify-content", value));
  bindField(wrap, (element, value) => element.style.setProperty("flex-wrap", value));
  bindField(padding, (element, value) => element.style.setProperty("padding", value));
  bindField(margin, (element, value) => element.style.setProperty("margin", value));
  bindField(radius, (element, value) => element.style.setProperty("border-radius", `${value}px`));
  bindField(overflow, (element, value) => element.style.setProperty("overflow", value));
  bindField(opacity, (element, value) => {
    if (value.trim() === "") return;
    element.style.setProperty("opacity", String(Number(value) / 100));
  });
  bindField(borderWidth, (element, value) =>
    element.style.setProperty("border-width", `${value}px`),
  );
  bindField(borderStyle, (element, value) => element.style.setProperty("border-style", value));
  bindField(borderColor, (element, value) => {
    const next = designColorWithAlpha(value, getComputedStyle(element).borderColor);
    borderColorText.value = next;
    element.style.setProperty("border-color", next);
  });
  bindField(borderColorText, (element, value) => {
    if (/^#[0-9a-f]{6}$/i.test(value)) borderColor.value = value;
    element.style.setProperty("border-color", value);
  });
  bindField(boxShadow, (element, value) => element.style.setProperty("box-shadow", value));
  exportSelection.addEventListener("click", () => {
    if (!selected) return;
    void navigator.clipboard.writeText(selected.outerHTML).then(
      () => {
        exportSelection.textContent = "Copied";
        globalThis.window.setTimeout(() => {
          exportSelection.textContent = "Copy HTML";
        }, 900);
      },
      () => {
        exportSelection.textContent = "Copy failed";
      },
    );
  });

  let editingText: HTMLElement | null = null;
  let finishEditingText: (() => void) | null = null;
  const positionTextToolbar = (): void => {
    if (!editingText) return;
    const rect = editingText.getBoundingClientRect();
    const box = textToolbar.getBoundingClientRect();
    textToolbar.style.left = `${Math.max(8, Math.min(rect.left + (rect.width - box.width) / 2, window.innerWidth - box.width - 8))}px`;
    textToolbar.style.top = `${Math.max(8, rect.top - box.height - 10)}px`;
  };
  const formatButton = (label: string, title: string, command: string): void => {
    const control = document.createElement("button");
    control.type = "button";
    control.className = command;
    control.textContent = label;
    control.title = title;
    control.setAttribute("aria-label", title);
    control.addEventListener("pointerdown", (event) => event.preventDefault());
    control.addEventListener("click", () => {
      if (!editingText) return;
      editingText.focus();
      const value = command === "createLink" ? window.prompt("Link URL") : null;
      if (command !== "createLink" || value)
        document.execCommand(command, false, value ?? undefined);
      refreshSelection();
      scheduleSave();
    });
    textToolbar.appendChild(control);
  };
  for (const [label, title, command] of [
    ["B", "Bold (⌘B)", "bold"],
    ["I", "Italic (⌘I)", "italic"],
    ["U", "Underline (⌘U)", "underline"],
    ["•", "Bulleted list", "insertUnorderedList"],
    ["1.", "Numbered list", "insertOrderedList"],
    ["Link", "Add link", "createLink"],
  ] as const) {
    if (command === "insertUnorderedList") {
      const divider = document.createElement("span");
      divider.className = "divider";
      textToolbar.appendChild(divider);
    }
    formatButton(label, title, command);
  }

  for (const direction of ["nw", "ne", "sw", "se"]) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = `handle ${direction}`;
    handle.setAttribute("aria-label", `Resize ${direction}`);
    handle.addEventListener("pointerdown", (event) => {
      if (!selected || event.button !== 0 || activePointerId !== null) return;
      const rect = boundsOf(selectionElements);
      if (rect.width === 0 || rect.height === 0) return;
      activePointerId = event.pointerId;
      handle.setPointerCapture(event.pointerId);
      transformElements = selectionElements
        .filter((element) => !element.hasAttribute(LOCK_ATTRIBUTE))
        .map((element) => ({
          element,
          before: stateOf(element),
          position: positionOf(element),
          rect: element.getBoundingClientRect(),
        }));
      beginSnapping();
      drag = {
        kind: "resize",
        start: { x: event.clientX, y: event.clientY },
        width: rect.width / zoom,
        height: rect.height / zoom,
        direction,
      };
      event.preventDefault();
      event.stopPropagation();
    });
    selection.appendChild(handle);
  }

  const positionShape = (element: HTMLElement, start: Point, end: Point): void => {
    element.style.left = `${Math.min(start.x, end.x)}px`;
    element.style.top = `${Math.min(start.y, end.y)}px`;
    element.style.width = `${Math.abs(end.x - start.x)}px`;
    element.style.height = `${Math.abs(end.y - start.y)}px`;
  };

  const renderSvg = (svg: SVGSVGElement, points: Point[], arrow: boolean): void => {
    if (svg.getAttribute(OBJECT_ATTRIBUTE) === "diamond") {
      const start = points[0]!;
      const end = points.at(-1)!;
      svg.style.left = `${Math.min(start.x, end.x)}px`;
      svg.style.top = `${Math.min(start.y, end.y)}px`;
      svg.style.width = `${Math.max(1, Math.abs(end.x - start.x))}px`;
      svg.style.height = `${Math.max(1, Math.abs(end.y - start.y))}px`;
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.innerHTML =
        '<polygon points="50,1 99,50 50,99 1,50" fill="var(--t3-design-fill,none)" stroke="var(--t3-design-stroke,currentColor)" stroke-width="var(--t3-design-stroke-width,2)" stroke-dasharray="var(--t3-design-stroke-dasharray,none)" vector-effect="non-scaling-stroke"/>';
      return;
    }
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const left = Math.min(...xs) - 8;
    const top = Math.min(...ys) - 8;
    const widthValue = Math.max(16, Math.max(...xs) - Math.min(...xs) + 16);
    const heightValue = Math.max(16, Math.max(...ys) - Math.min(...ys) + 16);
    svg.style.left = `${left}px`;
    svg.style.top = `${top}px`;
    svg.style.width = `${widthValue}px`;
    svg.style.height = `${heightValue}px`;
    svg.setAttribute("viewBox", `0 0 ${widthValue} ${heightValue}`);
    const local = points.map((point) => ({ x: point.x - left, y: point.y - top }));
    if (!arrow) {
      svg.innerHTML = `<path d="${local.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")}" fill="none" stroke="var(--t3-design-stroke,currentColor)" stroke-width="var(--t3-design-stroke-width,4)" stroke-dasharray="var(--t3-design-stroke-dasharray,none)" stroke-linecap="round" stroke-linejoin="round"/>`;
      return;
    }
    const start = local[0]!;
    const end = local.at(-1)!;
    const length = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
    const ux = (end.x - start.x) / length;
    const uy = (end.y - start.y) / length;
    const baseX = end.x - ux * 13;
    const baseY = end.y - uy * 13;
    const wing = 6;
    svg.innerHTML = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="var(--t3-design-stroke,currentColor)" stroke-width="var(--t3-design-stroke-width,4)" stroke-dasharray="var(--t3-design-stroke-dasharray,none)" stroke-linecap="round"/><polygon points="${end.x},${end.y} ${baseX - uy * wing},${baseY + ux * wing} ${baseX + uy * wing},${baseY - ux * wing}" fill="var(--t3-design-stroke,currentColor)"/>`;
  };

  const beginCreation = (
    event: PointerEvent,
    creationTool: Exclude<Tool, "select" | "hand">,
  ): void => {
    const start = pagePoint(event);
    if (
      creationTool === "draw" ||
      creationTool === "arrow" ||
      creationTool === "line" ||
      creationTool === "diamond"
    ) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute(OBJECT_ATTRIBUTE, creationTool);
      svg.setAttribute("data-t3-design-id", nextId());
      svg.style.cssText = "position:absolute;pointer-events:auto;overflow:visible;color:#1e1e1e";
      designLayer().appendChild(svg);
      drag = { kind: "create", tool: creationTool, start, element: svg, points: [start] };
      renderSvg(svg, [start, start], creationTool === "arrow");
      return;
    }
    const element = baseObject(creationTool, start.x, start.y);
    if (creationTool === "box")
      element.style.cssText += ";border:3px solid #1e1e1e;background:transparent";

    if (creationTool === "circle")
      element.style.cssText +=
        ";border:3px solid #1e1e1e;border-radius:9999px;background:transparent";
    if (creationTool === "highlight")
      element.style.cssText += ";border-radius:4px;background:rgba(250,204,21,.42)";
    designLayer().appendChild(element);
    drag = { kind: "create", tool: creationTool, start, element, points: [start] };
  };

  const annotationActive = (): boolean =>
    document.documentElement.hasAttribute(ANNOTATION_TOOL_ATTRIBUTE);

  const hideHover = (): void => {
    hover.style.display = "none";
  };

  const updateHover = (event: PointerEvent): void => {
    if (tool !== "select" || drag || isUiElement(event.target)) {
      hideHover();
      return;
    }
    const target = targetFromPoint(event.clientX, event.clientY);
    if (!target || target === selected) {
      hideHover();
      return;
    }
    const rect = target.getBoundingClientRect();
    hover.style.display = "block";
    hover.style.transform = `translate(${rect.left}px,${rect.top}px)`;
    hover.style.width = `${rect.width}px`;
    hover.style.height = `${rect.height}px`;
  };

  const SNAP_DISTANCE = 6;
  let snapCandidates: DOMRect[] = [];
  let dragBounds: DOMRect | null = null;
  const guideLayer = document.createElement("div");
  guideLayer.className = "guides";
  root.append(guideLayer);
  const guidePool: HTMLDivElement[] = [];
  const drawGuides = (lines: Guide[]): void => {
    while (guidePool.length < lines.length) {
      const line = document.createElement("div");
      line.className = "guide";
      guideLayer.append(line);
      guidePool.push(line);
    }
    for (const [index, line] of guidePool.entries()) {
      const spec = lines[index];
      line.hidden = !spec;
      if (!spec) continue;
      line.style.transform = `translate(${spec.x}px,${spec.y}px)`;
      line.style.width = `${spec.width}px`;
      line.style.height = `${spec.height}px`;
    }
  };
  const beginSnapping = (): void => {
    dragBounds = boundsOf(selectionElements);
    const board = selected ? findArtboard(selected) : null;
    snapCandidates = [
      ...document.querySelectorAll(ARTBOARD_SELECTOR),
      ...(board ? [board, ...board.querySelectorAll("*")] : []),
    ]
      .filter(
        (element) =>
          !["SCRIPT", "STYLE", "LINK", "META"].includes(element.tagName) &&
          !selectionElements.some((item) => item === element || item.contains(element)),
      )
      .slice(0, 200)
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
  };
  const endSnapping = (): void => {
    snapCandidates = [];
    dragBounds = null;
    drawGuides([]);
  };
  const horizontalEdges = (rect: DOMRect): number[] => [
    rect.left,
    rect.left + rect.width / 2,
    rect.right,
  ];
  const verticalEdges = (rect: DOMRect): number[] => [
    rect.top,
    rect.top + rect.height / 2,
    rect.bottom,
  ];
  const snapAxis = (
    start: number,
    size: number,
    delta: number,
    edges: (rect: DOMRect) => number[],
  ): { offset: number; line: number } | null => {
    const moving = [start + delta, start + delta + size / 2, start + delta + size];
    let best: { offset: number; line: number } | null = null;
    for (const rect of snapCandidates)
      for (const target of edges(rect))
        for (const position of moving) {
          const offset = target - position;
          if (
            Math.abs(offset) <= SNAP_DISTANCE &&
            (!best || Math.abs(offset) < Math.abs(best.offset))
          )
            best = { offset, line: target };
        }
    return best;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (activePointerId !== null) return;
    keyboardNavigation = false;
    if (editorOpen && !isUiElement(event.target)) window.focus();
    if (
      editorOpen &&
      !isUiElement(event.target) &&
      !editingText &&
      root.activeElement instanceof HTMLElement
    )
      root.activeElement.blur();
    if (
      editorOpen &&
      !annotationActive() &&
      !isUiElement(event.target) &&
      (event.button === 1 || (event.button === 0 && (tool === "hand" || spaceHeld)))
    ) {
      activePointerId = event.pointerId;
      pan = { start: { x: event.clientX, y: event.clientY }, offset: { ...offset } };
      if (event.target instanceof Element) event.target.setPointerCapture(event.pointerId);
      updateCursor();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!editorOpen || annotationActive() || event.button !== 0 || isUiElement(event.target))
      return;
    hideHover();
    if (editingText && event.target instanceof Node) {
      if (editingText.contains(event.target)) return;
      finishEditingText?.();
    }
    activePointerId = event.pointerId;
    if (event.target instanceof Element) event.target.setPointerCapture(event.pointerId);
    if (tool !== "select" && tool !== "hand") {
      beginCreation(event, tool);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = targetFromPoint(event.clientX, event.clientY);
    if (event.shiftKey && target) {
      selectElement(target, true, true, event.ctrlKey || event.metaKey);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      target &&
      (event.ctrlKey ||
        event.metaKey ||
        !selectionElements.includes(target as HTMLElement | SVGElement))
    )
      selectElement(target, true, false, event.ctrlKey || event.metaKey);
    if (event.altKey && target && selected) {
      dragBatch = { index: historyIndex, history, selection: [...selectionElements] };
      duplicateSelection(false);
    }
    if (target && selected) {
      transformElements = selectionElements
        .filter((element) => !element.hasAttribute(LOCK_ATTRIBUTE))
        .map((element) => ({
          element,
          before: stateOf(element),
          position: positionOf(element),
          rect: element.getBoundingClientRect(),
        }));
      beginSnapping();
      drag = {
        kind: "move",
        start: { x: event.clientX, y: event.clientY },
      };
    } else {
      marquee = {
        start: { x: event.clientX, y: event.clientY },
        previous: [...selectionElements],
        additive: event.shiftKey,
      };
      if (!event.shiftKey) selectElement(null);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    if (!editorOpen || annotationActive()) return;
    if (pan) {
      offset = {
        x: pan.offset.x + event.clientX - pan.start.x,
        y: pan.offset.y + event.clientY - pan.start.y,
      };
      renderViewport();
      event.preventDefault();
      return;
    }
    if (marquee) {
      const left = Math.min(marquee.start.x, event.clientX);
      const top = Math.min(marquee.start.y, event.clientY);
      const right = Math.max(marquee.start.x, event.clientX);
      const bottom = Math.max(marquee.start.y, event.clientY);
      marqueeBox.style.cssText = `display:block;left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px`;
      selectElements(
        [
          ...(marquee.additive ? marquee.previous : []),
          ...editableElements()
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return (
                !element.hasAttribute(LOCK_ATTRIBUTE) &&
                rect.width > 0 &&
                rect.height > 0 &&
                rect.left >= left &&
                rect.right <= right &&
                rect.top >= top &&
                rect.bottom <= bottom
              );
            })
            .flatMap(groupMembers),
        ],
        false,
      );
      return;
    }
    if (!drag) {
      updateHover(event);
      return;
    }
    hideHover();
    if (drag.kind === "move") {
      let dx = (event.clientX - drag.start.x) / zoom;
      let dy = (event.clientY - drag.start.y) / zoom;
      if (event.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const lines: Guide[] = [];
      if (!event.altKey && dragBounds) {
        const horizontal = snapAxis(dragBounds.left, dragBounds.width, dx * zoom, horizontalEdges);
        if (horizontal) {
          dx += horizontal.offset / zoom;
          lines.push({ x: horizontal.line, y: 0, width: 1, height: window.innerHeight });
        }
        const vertical = snapAxis(dragBounds.top, dragBounds.height, dy * zoom, verticalEdges);
        if (vertical) {
          dy += vertical.offset / zoom;
          lines.push({ x: 0, y: vertical.line, width: window.innerWidth, height: 1 });
        }
      }
      drawGuides(lines);
      for (const { element, position } of transformElements) {
        const x = position.x + dx;
        const y = position.y + dy;
        element.setAttribute("data-t3-design-x", String(x));
        element.setAttribute("data-t3-design-y", String(y));
        element.style.translate = `${x}px ${y}px`;
      }
    } else if (drag.kind === "resize") {
      const west = drag.direction.includes("w");
      const north = drag.direction.includes("n");
      let rawX = event.clientX - drag.start.x;
      let rawY = event.clientY - drag.start.y;
      const lines: Guide[] = [];
      if (!event.altKey && dragBounds) {
        const horizontal = snapAxis(
          west ? dragBounds.left : dragBounds.right,
          0,
          rawX,
          horizontalEdges,
        );
        if (horizontal) {
          rawX += horizontal.offset;
          lines.push({ x: horizontal.line, y: 0, width: 1, height: window.innerHeight });
        }
        const vertical = snapAxis(
          north ? dragBounds.top : dragBounds.bottom,
          0,
          rawY,
          verticalEdges,
        );
        if (vertical) {
          rawY += vertical.offset;
          lines.push({ x: 0, y: vertical.line, width: window.innerWidth, height: 1 });
        }
      }
      drawGuides(lines);
      const nextWidth = Math.max(8, drag.width + (rawX / zoom) * (west ? -1 : 1));
      const nextHeight = Math.max(8, drag.height + (rawY / zoom) * (north ? -1 : 1));
      const rects = transformElements.map((item) => item.rect);
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      let sx = nextWidth / drag.width;
      let sy = nextHeight / drag.height;
      if (event.shiftKey) sx = sy = Math.max(sx, sy);
      for (const { element, position, rect } of transformElements) {
        const x =
          position.x + (west ? drag.width * (1 - sx) : 0) + ((rect.left - left) / zoom) * (sx - 1);
        const y =
          position.y + (north ? drag.height * (1 - sy) : 0) + ((rect.top - top) / zoom) * (sy - 1);
        element.style.minWidth = "0";
        element.style.maxWidth = "none";
        element.style.minHeight = "0";
        element.style.maxHeight = "none";
        element.style.width = `${(rect.width / zoom) * sx}px`;
        element.style.height = `${(rect.height / zoom) * sy}px`;
        element.style.translate = `${x}px ${y}px`;
        element.setAttribute("data-t3-design-x", String(x));
        element.setAttribute("data-t3-design-y", String(y));
      }
    } else {
      const end = pagePoint(event);
      if (event.shiftKey && drag.tool !== "draw") {
        const dx = end.x - drag.start.x;
        const dy = end.y - drag.start.y;
        if (drag.tool === "arrow" || drag.tool === "line") {
          const angle = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
          const length = Math.hypot(dx, dy);
          end.x = drag.start.x + Math.cos(angle) * length;
          end.y = drag.start.y + Math.sin(angle) * length;
        } else {
          const size = Math.max(Math.abs(dx), Math.abs(dy));
          end.x = drag.start.x + Math.sign(dx || 1) * size;
          end.y = drag.start.y + Math.sign(dy || 1) * size;
        }
      }
      if (drag.element instanceof SVGSVGElement) {
        if (drag.tool === "draw") drag.points.push(end);
        else drag.points = [drag.start, end];
        renderSvg(drag.element, drag.points, drag.tool === "arrow");
      } else {
        positionShape(drag.element, drag.start, end);
      }
    }
    refreshSelection();
    event.preventDefault();
    event.stopPropagation();
  };

  const cancelDrag = (): void => {
    activePointerId = null;
    pan = null;
    updateCursor();
    if (marquee) selectElements(marquee.previous, false);
    marquee = null;
    marqueeBox.style.display = "none";
    if (drag?.kind === "move" || drag?.kind === "resize")
      for (const { element, before } of transformElements) applyState(element, before);
    else cancelDesignInteraction(drag);
    transformElements = [];
    drag = null;
    endSnapping();
    if (dragBatch) {
      for (let index = historyIndex - 1; index >= dragBatch.index; index -= 1)
        history[index]!.undo();
      history = dragBatch.history;
      historyIndex = dragBatch.index;
      selectElements(dragBatch.selection);
      dragBatch = null;
      refreshHistoryButtons();
    }
    refreshSelection();
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    pan = null;
    updateCursor();
    endSnapping();
    if (marquee) {
      marquee = null;
      marqueeBox.style.display = "none";
      scheduleSave();
    }
    if (!editorOpen || annotationActive() || !drag) return;
    const completed = drag;
    drag = null;
    if (completed.kind === "move" || completed.kind === "resize") {
      batch(() => {
        for (const { element, before } of transformElements) commitElementState(element, before);
      });
      transformElements = [];
      if (dragBatch) {
        recordBatch(dragBatch.index, dragBatch.selection);
        dragBatch = null;
      }
    } else {
      const rect = completed.element.getBoundingClientRect();
      if (rect.width / zoom < MIN_SHAPE_SIZE || rect.height / zoom < MIN_SHAPE_SIZE)
        completed.element.remove();
      else {
        const element = completed.element;
        const layer = element.parentNode!;
        pushHistory({ undo: () => element.remove(), redo: () => layer.appendChild(element) });
        selectElement(element);
      }
      setTool("select");
    }
    refreshSelection();
    event.preventDefault();
    event.stopPropagation();
  };

  const startEditingText = (target: EventTarget | null): void => {
    if (
      !(target instanceof HTMLElement) ||
      !!target.querySelector(
        "div,section,article,main,form,input,button,svg,img,table,h1,h2,h3,p",
      ) ||
      editingText === target ||
      target.hasAttribute(LOCK_ATTRIBUTE)
    )
      return;
    const before = target.innerHTML;
    editingText = target;
    target.setAttribute(DESIGN_EDITING_ATTRIBUTE, "");
    target.contentEditable = "true";
    textToolbar.style.display = "flex";
    selectElement(target, true, false, true);
    target.focus();
    positionTextToolbar();
    const onInput = (): void => {
      refreshSelection();
      scheduleSave();
    };
    const finish = (): void => {
      target.removeEventListener("input", onInput);
      target.removeEventListener("blur", finish);
      target.blur();
      target.removeAttribute(DESIGN_EDITING_ATTRIBUTE);
      target.removeAttribute("contenteditable");
      if (editingText === target) {
        editingText = null;
        finishEditingText = null;
      }
      textToolbar.style.display = "none";
      const after = target.innerHTML;
      if (before !== after) {
        pushHistory({
          undo: () => {
            target.innerHTML = before;
          },
          redo: () => {
            target.innerHTML = after;
          },
        });
        refreshLayers();
      }
      refreshSelection();
    };
    target.addEventListener("input", onInput);
    finishEditingText = finish;
    target.addEventListener("blur", finish, { once: true });
  };

  const editText = (event: MouseEvent): void => {
    if (!editorOpen || annotationActive() || tool !== "select" || isUiElement(event.target)) return;
    startEditingText(event.target);
    if (editingText) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const isTyping = (eventTarget: EventTarget | null): boolean => {
    const target = root.activeElement ?? eventTarget;
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  };
  let copied: {
    elements: { element: HTMLElement | SVGElement; parent: HTMLElement; next: ChildNode | null }[];
    html: string;
  } | null = null;
  const copySelection = (event: ClipboardEvent): void => {
    if (
      !editorOpen ||
      annotationActive() ||
      help.open ||
      drag ||
      pan ||
      isTyping(event.target) ||
      !selected?.parentElement ||
      !event.clipboardData
    )
      return;
    copied = {
      elements: selectionElements.map((element) => ({
        element: element.cloneNode(true) as HTMLElement | SVGElement,
        parent: element.parentElement!,
        next: element.nextSibling,
      })),
      html: selectionElements.map((element) => element.outerHTML).join("\n"),
    };
    event.clipboardData.setData("text/plain", copied.html);
    event.clipboardData.setData("text/html", copied.html);
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "cut") remove.click();
  };
  window.addEventListener("copy", copySelection);
  window.addEventListener("cut", copySelection);
  window.addEventListener("paste", (event) => {
    if (
      !editorOpen ||
      annotationActive() ||
      help.open ||
      drag ||
      pan ||
      isTyping(event.target) ||
      !event.clipboardData
    )
      return;
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    const clipboard = copied;
    if (clipboard && text === clipboard.html)
      batch(() => {
        const groups = new Map<string, string>();
        selectElements(
          clipboard.elements
            .map(({ element, parent, next }) =>
              duplicateElement(element, parent.isConnected ? parent : designLayer(), next, groups),
            )
            .filter((element) => element !== null),
        );
      });
    else addText(false, text);
    setTool("select");
  });

  const editSelection = (update: (element: HTMLElement | SVGElement) => void): void =>
    batch(() => {
      for (const element of selectionElements) {
        if (element.hasAttribute(LOCK_ATTRIBUTE)) continue;
        const before = stateOf(element);
        update(element);
        commitElementState(element, before);
      }
      refreshSelection();
    });
  const moveElement = (element: HTMLElement | SVGElement, dx: number, dy: number): void => {
    const position = positionOf(element);
    const x = position.x + dx;
    const y = position.y + dy;
    element.style.translate = `${x}px ${y}px`;
    element.setAttribute("data-t3-design-x", String(x));
    element.setAttribute("data-t3-design-y", String(y));
  };
  const groupSelection = (ungroup = false): void =>
    batch(() => {
      if (!ungroup && selectionElements.length < 2) return;
      const id = nextId();
      const groups = new Set(selectionElements.map(groupOf));
      const elements = ungroup
        ? editableElements().filter((element) => groups.has(groupOf(element)) && groupOf(element))
        : selectionElements;
      for (const element of elements) {
        const before = element.getAttribute(GROUP_ATTRIBUTE);
        const after = ungroup
          ? before?.split(" ").slice(0, -1).join(" ") || null
          : [before, id].filter(Boolean).join(" ");
        const apply = (value: string | null): void => {
          if (value) element.setAttribute(GROUP_ATTRIBUTE, value);
          else element.removeAttribute(GROUP_ATTRIBUTE);
        };
        apply(after);
        pushHistory({ undo: () => apply(before), redo: () => apply(after) });
      }
      selectElements(elements);
    });
  const toggleLock = (): void =>
    batch(() => {
      const lock = selectionElements.some((element) => !element.hasAttribute(LOCK_ATTRIBUTE));
      for (const element of selectionElements) {
        const before = element.hasAttribute(LOCK_ATTRIBUTE);
        element.toggleAttribute(LOCK_ATTRIBUTE, lock);
        pushHistory({
          undo: () => element.toggleAttribute(LOCK_ATTRIBUTE, before),
          redo: () => element.toggleAttribute(LOCK_ATTRIBUTE, lock),
        });
      }
      scheduleSave();
      refreshSelection();
    });
  const reorderSelection = (forward: boolean, edge: boolean): void =>
    batch(() => {
      const elements = [...selectionElements].sort(
        (a, b) =>
          (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) *
          (forward !== edge ? -1 : 1),
      );
      for (const element of elements) {
        if (element.hasAttribute(LOCK_ATTRIBUTE)) continue;
        const parent = element.parentElement;
        if (!parent) continue;
        const next = element.nextSibling;
        const before = stateOf(element);
        const siblings = [...parent.children].filter(
          (item) => !selectionElements.includes(item as HTMLElement | SVGElement),
        );
        const sibling = forward ? element.nextElementSibling : element.previousElementSibling;
        if (edge) parent.insertBefore(element, forward ? null : parent.firstChild);
        else if (sibling && !selectionElements.includes(sibling as HTMLElement | SVGElement))
          parent.insertBefore(element, forward ? sibling.nextSibling : sibling);
        if (getComputedStyle(element).position !== "static") {
          const indices = (edge ? siblings : sibling ? [sibling] : []).map(
            (item) => Number.parseInt(getComputedStyle(item).zIndex) || 0,
          );
          if (indices.length)
            element.style.zIndex = String(
              (forward ? Math.max(...indices) : Math.min(...indices)) + (forward ? 1 : -1),
            );
        }
        const after = stateOf(element);
        const afterNext = element.nextSibling;
        if (next === afterNext && statesMatch(before, after)) continue;
        const apply = (state: ElementState, anchor: ChildNode | null): void => {
          parent.insertBefore(element, anchor?.parentNode === parent ? anchor : null);
          applyState(element, state);
        };
        pushHistory({ undo: () => apply(before, next), redo: () => apply(after, afterNext) });
      }
      refreshLayers();
      scheduleSave();
    });
  const alignSelection = (axis: "x" | "y", edge: "start" | "center" | "end"): void => {
    if (selectionElements.length < 2) return;
    const bounds = boundsOf(selectionElements);
    const factor = edge === "start" ? 0 : edge === "center" ? 0.5 : 1;
    editSelection((element) => {
      const rect = element.getBoundingClientRect();
      const delta =
        axis === "x"
          ? bounds.left + bounds.width * factor - rect.left - rect.width * factor
          : bounds.top + bounds.height * factor - rect.top - rect.height * factor;
      moveElement(element, axis === "x" ? delta / zoom : 0, axis === "y" ? delta / zoom : 0);
    });
  };
  const distributeSelection = (axis: "x" | "y"): void => {
    if (selectionElements.length < 3) return;
    const items = selectionElements
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .sort((a, b) => a.rect[axis] - b.rect[axis]);
    const size = axis === "x" ? "width" : "height";
    const first = items[0]!;
    const last = items.at(-1)!;
    const gap =
      (last.rect[axis] +
        last.rect[size] -
        first.rect[axis] -
        items.reduce((sum, item) => sum + item.rect[size], 0)) /
      (items.length - 1);
    let position = first.rect[axis];
    const deltas = new Map(
      items.map(({ element, rect }) => {
        const delta = (position - rect[axis]) / zoom;
        position += rect[size] + gap;
        return [element, delta];
      }),
    );
    editSelection((element) =>
      moveElement(
        element,
        axis === "x" ? deltas.get(element)! : 0,
        axis === "y" ? deltas.get(element)! : 0,
      ),
    );
  };
  const selectionActions = section("Selection actions");
  button("Group", () => groupSelection(), selectionActions).title = "Group (Ctrl / ⌘ + G)";
  button("Ungroup", () => groupSelection(true), selectionActions).title =
    "Ungroup (Ctrl / ⌘ + Shift + G)";
  button("Lock / unlock", toggleLock, selectionActions).title =
    "Lock / unlock (Ctrl / ⌘ + Shift + L)";
  button("Bring forward", () => reorderSelection(true, false), selectionActions).title =
    "Ctrl / ⌘ + ]";
  button("Send backward", () => reorderSelection(false, false), selectionActions).title =
    "Ctrl / ⌘ + [";
  button("Bring to front", () => reorderSelection(true, true), selectionActions).title =
    "Ctrl / ⌘ + Shift + ]";
  button("Send to back", () => reorderSelection(false, true), selectionActions).title =
    "Ctrl / ⌘ + Shift + [";
  for (const [label, axis, edge] of [
    ["Align left", "x", "start"],
    ["Center horizontally", "x", "center"],
    ["Align right", "x", "end"],
    ["Align top", "y", "start"],
    ["Center vertically", "y", "center"],
    ["Align bottom", "y", "end"],
  ] as const)
    button(label, () => alignSelection(axis, edge), selectionActions);

  button("Distribute horizontally", () => distributeSelection("x"), selectionActions);
  button("Distribute vertically", () => distributeSelection("y"), selectionActions);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!editorOpen || annotationActive() || event.isComposing) return;
    if (help.open) return;
    if (event.key === "Tab") {
      if (!root.activeElement && selectionElements.length && !isTyping(event.target)) {
        const elements = editableElements().filter(
          (element) =>
            element.parentElement === selected?.parentElement &&
            !element.hasAttribute(LOCK_ATTRIBUTE) &&
            getComputedStyle(element).visibility !== "hidden",
        );
        const index = elements.indexOf(selected!);
        selectElement(
          elements[(index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length] ?? null,
        );
        event.preventDefault();
        event.stopPropagation();
      } else keyboardNavigation = true;
      return;
    }
    const key = event.key.toLowerCase();
    const modifier = event.metaKey || event.ctrlKey;
    if (editingText && (key === "escape" || (modifier && key === "enter"))) {
      finishEditingText?.();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (modifier && !event.altKey && key === "s") {
      if (drag || pan || marquee) cancelDrag();
      finishEditingText?.();
      save();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (editingText && modifier && ["b", "i", "u"].includes(key)) {
      document.execCommand(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isTyping(event.target)) return;
    const target = root.activeElement ?? event.target;
    if (
      keyboardNavigation &&
      root.activeElement === target &&
      target instanceof Element &&
      target.matches("button:focus-visible,summary:focus-visible") &&
      (event.code === "Space" || key === "enter")
    )
      return;
    if (key === "escape" && (drag || pan || marquee)) {
      cancelDrag();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.altKey) {
      const alignment = {
        a: ["x", "start"],
        h: ["x", "center"],
        d: ["x", "end"],
        w: ["y", "start"],
        v: ["y", "center"],
        s: ["y", "end"],
      } as const;
      const letter = event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : key;
      if (modifier && ["h", "v"].includes(letter)) {
        distributeSelection(letter === "h" ? "x" : "y");
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const choice = alignment[letter as keyof typeof alignment];
      if (choice && !modifier) {
        alignSelection(choice[0], choice[1]);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (modifier) {
      if (key === "z") {
        if (drag || pan || marquee) cancelDrag();
        else runHistory(event.shiftKey ? 1 : -1);
      } else if (key === "y") {
        if (drag || pan || marquee) cancelDrag();
        else runHistory(1);
      } else if (key === "d") {
        if (selected && !drag && !event.repeat) duplicateSelection();
      } else if (key === "a") {
        setTool("select");
        const boards = [...document.querySelectorAll(ARTBOARD_SELECTOR)];
        selectElements(
          (boards.length
            ? [...boards, ...document.querySelectorAll(`[${OBJECT_ATTRIBUTE}="layer"] > *`)]
            : [...document.body.children].flatMap((element) =>
                element.getAttribute(OBJECT_ATTRIBUTE) === "layer"
                  ? [...element.children]
                  : [element],
              )
          ).filter(
            (element) =>
              !element.hasAttribute(LOCK_ATTRIBUTE) &&
              !["STYLE", "SCRIPT", "LINK"].includes(element.tagName),
          ),
        );
      } else if (key === "g") groupSelection(event.shiftKey);
      else if (event.shiftKey && key === "l") toggleLock();
      else if (event.code === "BracketRight" || event.code === "BracketLeft")
        reorderSelection(event.code === "BracketRight", event.shiftKey);
      else if (event.shiftKey && key === "h") {
        const hide = selectionElements.some(
          (element) => getComputedStyle(element).visibility !== "hidden",
        );
        editSelection((element) => {
          element.style.visibility = hide ? "hidden" : "visible";
        });
      } else if (key === "=" || key === "+") setZoom(zoom * 1.2);
      else if (key === "-") setZoom(zoom / 1.2);
      else if (key === "0") setZoom(1);
      else return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.code === "Space") {
      spaceHeld = true;
      updateCursor();
      refreshSelection();
      event.preventDefault();
      return;
    }
    if (event.shiftKey && ["Digit1", "Digit2"].includes(event.code)) {
      if (event.code === "Digit1") fitCanvas();
      else if (selected) fitCanvas(selectionElements);
      event.preventDefault();
      return;
    }
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      event.key
    ];
    if (nudge && selected && !drag) {
      const step = event.shiftKey ? 10 : 1;
      editSelection((element) => moveElement(element, nudge[0]! * step, nudge[1]! * step));
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (key === "escape" && (drag || pan || marquee)) cancelDrag();
    else if (key === "delete" || key === "backspace") {
      if (!drag) remove.click();
    } else if (key === "escape" && tool === "select" && selected) selectElement(null);
    else if (key === "escape" || ["v", "1"].includes(key)) setTool("select");
    else if (["p", "7"].includes(key)) setTool("draw");
    else if (["d", "3"].includes(key)) setTool("diamond");
    else if (["l", "6"].includes(key)) setTool("line");
    else if (["a", "5"].includes(key)) setTool("arrow");
    else if (["b", "r", "2"].includes(key)) setTool("box");
    else if (["c", "o", "4"].includes(key)) setTool("circle");
    else if (key === "h") setTool(event.shiftKey ? "highlight" : "hand");
    else if (["t", "8", "n"].includes(key)) {
      if (!event.repeat) {
        addText(key === "n");
        setTool("select");
      }
    } else if (key === "enter" && selected && selectionElements.length === 1)
      startEditingText(selected);
    else if (key === "?") help.showModal();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const preventNavigation = (event: MouseEvent): void => {
    if (editingText && event.target instanceof Node && editingText.contains(event.target)) return;
    if (editorOpen && !annotationActive() && !isUiElement(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const setEditorOpen = (active: boolean): void => {
    editorOpen = active;
    host.style.display = active && !annotationActive() ? "" : "none";
    toolbar.hidden = !active || !panelOpen;
    pan = null;
    spaceHeld = false;
    document.documentElement.toggleAttribute(DESIGN_OPEN_ATTRIBUTE, active && !annotationActive());
    cancelDrag();
    finishEditingText?.();
    hideHover();
    setTool("hand");
    if (!active) {
      selection.style.display = "none";
      textToolbar.style.display = "none";
      return;
    }
    refreshLayers();
    refreshSelection();
    if (!hasFitted) {
      hasFitted = true;
      fitCanvas();
    }
  };

  const setTheme = (theme: DesktopPreviewAnnotationTheme | null): void => {
    applyAnnotationTheme(host, theme);
    if (theme)
      document.documentElement.style.setProperty(
        "--t3-canvas-background",
        `color-mix(in srgb, ${theme.background} ${theme.colorScheme === "dark" ? 96 : 92}%, ${theme.foreground})`,
      );
  };
  setTheme(options.theme ?? null);

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener(
    "pointercancel",
    (event) => {
      if (event.pointerId === activePointerId) cancelDrag();
    },
    true,
  );
  window.addEventListener("click", preventNavigation, true);
  window.addEventListener("dblclick", editText, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("pagehide", flushSave, { once: true });
  window.addEventListener(
    "scroll",
    () => {
      refreshSelection();
      hideHover();
    },
    { capture: true, passive: true },
  );
  window.addEventListener("resize", refreshSelection, { passive: true });
  document.documentElement.appendChild(host);
  const annotationObserver = new MutationObserver(() => {
    const active = annotationActive();
    host.style.display = active || !editorOpen ? "none" : "";
    document.documentElement.toggleAttribute(DESIGN_OPEN_ATTRIBUTE, editorOpen && !active);
    if (active) {
      cancelDrag();
      finishEditingText?.();
      hideHover();
    }
  });
  annotationObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ANNOTATION_TOOL_ATTRIBUTE],
  });
  window.addEventListener(
    "pagehide",
    () => {
      annotationObserver.disconnect();
    },
    { once: true },
  );
  setEditorOpen(false);
  refreshHistoryButtons();
  selectElement(null, false);
  return {
    setOpen: setEditorOpen,
    setTheme,
    flush: flushSave,
    save: () => save(),
  };
}
