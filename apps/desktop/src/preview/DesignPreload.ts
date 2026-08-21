// @effect-diagnostics globalDate:off - This isolated Electron preload does not run inside an Effect runtime.
import { ipcRenderer } from "electron";
import type { DesktopPreviewDesignChangePayload } from "@t3tools/contracts";

import {
  applyDesignElementState as applyState,
  captureDesignElementState as stateOf,
  createDesignSelectionAnnotation,
  DESIGN_EDITING_ATTRIBUTE,
  DESIGN_OPEN_ATTRIBUTE,
  DESIGN_UI_ATTRIBUTE,
  designElementStatesMatch as statesMatch,
  designPathFromUrl,
  discardPendingDesignObject,
  resolveDesignPosition,
  serializeDesignDocument,
  type DesignElementState as ElementState,
} from "./DesignDocument.ts";
import {
  ANNOTATION_TOOL_ATTRIBUTE,
  DESIGN_CHANGED_CHANNEL,
  DESIGN_EDITING_CHANNEL,
} from "./GuestProtocol.ts";

type Tool = "select" | "draw" | "arrow" | "box" | "circle" | "highlight";
type Point = { x: number; y: number };
type HistoryEntry = { undo: () => void; redo: () => void };
type DragState =
  | {
      kind: "move";
      element: HTMLElement | SVGElement;
      start: Point;
      x: number;
      y: number;
      before: ElementState;
    }
  | {
      kind: "resize";
      element: HTMLElement | SVGElement;
      start: Point;
      width: number;
      height: number;
      x: number;
      y: number;
      direction: string;
      before: ElementState;
    }
  | {
      kind: "create";
      tool: Exclude<Tool, "select">;
      start: Point;
      element: HTMLElement | SVGSVGElement;
      points: Point[];
    };

const OBJECT_ATTRIBUTE = "data-t3-design-object";
const FOCUS_ATTRIBUTE = "data-t3-design-focus";
const SELECTED_ATTRIBUTE = "data-t3-design-selected";
const ARTBOARD_SELECTOR = "[data-t3-design-artboard]";
const SAVE_DELAY_MS = 200;
const MIN_SHAPE_SIZE = 5;
const PANEL_WIDTH = "min(292px,45vw)";
let idSequence = 0;

function nextId(): string {
  let id: string;
  do {
    idSequence += 1;
    id = `manual-${idSequence}`;
  } while (document.querySelector(`[data-t3-design-id="${id}"]`));
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
        element !== document.documentElement &&
        element !== document.body &&
        !["SCRIPT", "STYLE", "LINK", "META"].includes(element.tagName),
    );
  return target?.closest(`[${OBJECT_ATTRIBUTE}]`) ?? target ?? null;
}

function pagePoint(event: PointerEvent): Point {
  return { x: event.clientX + window.scrollX, y: event.clientY + window.scrollY };
}

function positionOf(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return resolveDesignPosition(
    element.getAttribute("data-t3-design-x"),
    element.getAttribute("data-t3-design-y"),
    getComputedStyle(element).translate,
    rect.width,
    rect.height,
  );
}

function rgbToHex(value: string, fallback: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const parts = value
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  return parts?.length === 3
    ? `#${parts
        .map((part) =>
          Math.max(0, Math.min(255, Math.round(part)))
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`
    : fallback;
}

function startDesignEditor(): void {
  if (!designPathFromUrl(location.href) || document.querySelector(`[${DESIGN_UI_ATTRIBUTE}]`))
    return;

  const host = document.createElement("div");
  host.setAttribute(DESIGN_UI_ATTRIBUTE, "");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "closed" });
  const pageStyle = document.createElement("style");
  pageStyle.setAttribute(DESIGN_UI_ATTRIBUTE, "");
  pageStyle.textContent = `html[${DESIGN_OPEN_ATTRIBUTE}]{width:calc(100% - ${PANEL_WIDTH})!important;min-width:0!important}html[${DESIGN_OPEN_ATTRIBUTE}] body{min-width:0!important;contain:paint}`;
  document.head.appendChild(pageStyle);
  const style = document.createElement("style");
  style.textContent = `
    :host{color-scheme:light dark;font:12px/1.35 ui-sans-serif,system-ui,sans-serif;color:light-dark(#202020,#f3f3f3)}
    *{box-sizing:border-box}
    button,input,textarea,select{font:inherit;color:inherit}
    button{height:28px;border:0;border-radius:7px;background:transparent;padding:0 9px;cursor:pointer;white-space:nowrap;transition:transform 120ms cubic-bezier(.23,1,.32,1),background-color 120ms ease}
    button:active:not(:disabled){transform:scale(.97)}
    button[aria-pressed=true]{background:light-dark(#e9e9e9,#353535);color:light-dark(#111,#fff)}
    button:disabled{opacity:.35;cursor:default}
    .panel{pointer-events:auto;position:fixed;inset:0 0 0 auto;display:flex;width:${PANEL_WIDTH};flex-direction:column;overflow:hidden;border-left:1px solid light-dark(#deddd9,#353535);background:light-dark(#faf9f6,#191919)}
    .panel[hidden]{display:none}.panel-header,.tools,.actions{display:flex;align-items:center;gap:4px;border-bottom:1px solid light-dark(#e5e3df,#353535)}
    .panel-header{min-height:44px;justify-content:space-between;padding:8px 12px;font-weight:650}.panel-header button{height:28px;background:light-dark(#242422,#f0efec);color:light-dark(#f8f7f4,#242422)}
    .editor-body{min-height:0;overflow:auto;overscroll-behavior:contain}.tools{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:2px;padding:7px 8px}.tools button{display:grid;height:32px;place-items:center;padding:0}.tools svg{width:16px;height:16px}
    .section{border-top:1px solid light-dark(#e5e3df,#353535);padding:11px 12px}.editor-body>.section:first-of-type{border-top:0}.section-title{display:flex;align-items:center;justify-content:space-between;margin:0 0 8px;font-size:12px;font-weight:650}.layers{max-height:152px;overflow:auto}.layer{display:block;width:100%;height:25px;overflow:hidden;text-align:left;text-overflow:ellipsis;color:light-dark(#575653,#b9b8b4)}.layer[aria-selected=true]{background:light-dark(#e8e7e3,#373737);color:inherit}
    .hover{display:none;pointer-events:none;position:fixed;z-index:0;border:2px solid #2563eb;background:rgba(37,99,235,.08);border-radius:3px}
    .selection{display:none;pointer-events:none;position:fixed;z-index:1;border:2px solid #e5486d;box-shadow:0 0 0 1px white;border-radius:2px}
    .tag{position:absolute;left:-2px;bottom:calc(100% + 5px);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:4px;background:#e5486d;color:white;padding:3px 6px}
    .handle{pointer-events:auto;position:absolute;width:10px;height:10px;border:2px solid white;border-radius:2px;background:#e5486d;padding:0}
    .nw{left:-6px;top:-6px;cursor:nwse-resize}.ne{right:-6px;top:-6px;cursor:nesw-resize}.sw{left:-6px;bottom:-6px;cursor:nesw-resize}.se{right:-6px;bottom:-6px;cursor:nwse-resize}
    .inspector{display:none}.inspector h2{margin:0;overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}
    .field{display:grid;grid-template-columns:74px minmax(0,1fr);align-items:center;gap:8px;margin-top:7px;color:light-dark(#686764,#aaa)}
    .field input,.field textarea,.field select{min-width:0;width:100%;border:1px solid light-dark(#dedcd7,#414141);border-radius:7px;background:light-dark(#fefdfa,#242424);padding:5px 7px;outline:none}
    .field input:focus,.field textarea:focus,.field select:focus{border-color:light-dark(#8f8d87,#737373);box-shadow:0 0 0 2px light-dark(rgba(0,0,0,.06),rgba(255,255,255,.08))}
    .field input,.field select{height:29px}.field input[type=color]{width:30px;padding:3px}.field textarea{height:56px;resize:vertical}.color-control{display:grid;grid-template-columns:30px minmax(0,1fr);gap:5px}
    .actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));padding:8px;border-top:1px solid light-dark(#e5e3df,#353535);border-bottom:0}.actions button{padding:0 4px;border:1px solid light-dark(#dfddd8,#414141)}.actions .attach{grid-column:1/-1;background:#2563eb;color:white;border-color:#2563eb}
    .text-toolbar{pointer-events:auto;position:fixed;display:none;gap:2px;padding:4px;border:1px solid light-dark(#d9d7d2,#414141);border-radius:9px;background:light-dark(#fff,#222);box-shadow:0 10px 28px rgba(0,0,0,.2)}.text-toolbar button{min-width:28px;padding:0 7px;font-size:13px}
    @media (hover:hover) and (pointer:fine){button:hover:not(:disabled){background:light-dark(#eceae6,#363636)}}
  `;
  root.appendChild(style);

  const toolbar = document.createElement("div");
  toolbar.className = "panel";
  const panelHeader = document.createElement("div");
  panelHeader.className = "panel-header";
  const panelTitle = document.createElement("span");
  panelTitle.textContent = "Edit";
  const saveNow = document.createElement("button");
  saveNow.type = "button";
  saveNow.textContent = "Save";
  panelHeader.append(panelTitle, saveNow);
  const editPanel = document.createElement("div");
  editPanel.className = "editor-body";
  const editTools = document.createElement("div");
  editTools.className = "tools";
  const layersSection = document.createElement("section");
  layersSection.className = "section";
  const layersTitle = document.createElement("h2");
  layersTitle.className = "section-title";
  layersTitle.textContent = "Layers";
  const layers = document.createElement("div");
  layers.className = "layers";
  layersSection.append(layersTitle, layers);
  const hover = document.createElement("div");
  hover.className = "hover";
  const selection = document.createElement("div");
  selection.className = "selection";
  const tag = document.createElement("div");
  tag.className = "tag";
  selection.appendChild(tag);
  const inspector = document.createElement("div");
  inspector.className = "inspector";
  const inspectorTitle = document.createElement("h2");
  const selectionSection = document.createElement("section");
  selectionSection.className = "section";
  selectionSection.appendChild(inspectorTitle);
  inspector.appendChild(selectionSection);
  editPanel.append(editTools, layersSection, inspector);
  const actions = document.createElement("div");
  actions.className = "actions";
  const textToolbar = document.createElement("div");
  textToolbar.className = "text-toolbar";
  toolbar.append(panelHeader, editPanel, actions);
  toolbar.hidden = true;
  root.append(toolbar, hover, selection, textToolbar);

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  let tool: Tool = "select";
  let selected: HTMLElement | SVGElement | null = null;
  let drag: DragState | null = null;
  let history: HistoryEntry[] = [];
  let historyIndex = 0;
  let saveTimer: number | null = null;
  let editorOpen = false;

  const save = (annotation?: DesktopPreviewDesignChangePayload["annotation"]): void => {
    saveTimer = null;
    const payload: DesktopPreviewDesignChangePayload = {
      html: serializeDesignDocument(document),
      ...(annotation ? { annotation } : {}),
    };
    ipcRenderer.send(DESIGN_CHANGED_CHANNEL, payload);
  };

  const scheduleSave = (): void => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, SAVE_DELAY_MS);
  };

  const flushSave = (): void => {
    if (saveTimer === null) return;
    window.clearTimeout(saveTimer);
    save();
  };

  saveNow.addEventListener("click", () => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    save();
    saveNow.textContent = "Saved";
    window.setTimeout(() => {
      saveNow.textContent = "Save";
    }, 900);
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
    if (!selected?.isConnected) {
      selected = null;
      selection.style.display = "none";
      inspector.style.display = "none";
      textToolbar.style.display = "none";
      attach.disabled = true;
      remove.disabled = true;
      choose.disabled = true;
      return;
    }
    const rect = selected.getBoundingClientRect();
    selection.style.display = "block";
    selection.style.transform = `translate(${rect.left}px,${rect.top}px)`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
    tag.textContent =
      selected.getAttribute("data-t3-design-id") ??
      selected.getAttribute(OBJECT_ATTRIBUTE) ??
      selected.tagName.toLowerCase();
    inspector.style.display = "block";
    inspectorTitle.textContent = tag.textContent;
    remove.disabled = false;
    choose.disabled = false;
    attach.disabled = false;
    const computed = getComputedStyle(selected);
    const position = positionOf(selected);
    textValue.disabled = selected.childElementCount > 0;
    setFieldValue(textValue, selected.childElementCount === 0 ? (selected.textContent ?? "") : "");
    const fillValue = rgbToHex(computed.backgroundColor, "#ffffff");
    const colorValue = rgbToHex(computed.color, "#111111");
    const borderColorValue = rgbToHex(computed.borderColor, "#000000");
    setFieldValue(fill, fillValue);
    setFieldValue(fillText, fillValue);
    setFieldValue(color, colorValue);
    setFieldValue(colorText, colorValue);
    setFieldValue(fontSize, String(Math.round(Number.parseFloat(computed.fontSize) || 16)));
    setFieldValue(width, String(Math.round(rect.width)));
    setFieldValue(height, String(Math.round(rect.height)));
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
    setFieldValue(borderColorText, borderColorValue);
    setFieldValue(boxShadow, computed.boxShadow === "none" ? "" : computed.boxShadow);
    choose.textContent = findArtboard(selected)?.hasAttribute(SELECTED_ATTRIBUTE)
      ? "Chosen"
      : "Choose";
  };

  function refreshLayers(): void {
    layers.replaceChildren();
    let count = 0;
    const append = (element: Element, depth: number): void => {
      if (count >= 160 || ["SCRIPT", "STYLE", "LINK", "META"].includes(element.tagName)) return;
      if (element.getAttribute(OBJECT_ATTRIBUTE) === "layer") {
        for (const child of element.children) append(child, depth);
        return;
      }
      count += 1;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "layer";
      row.style.paddingLeft = `${8 + Math.min(depth, 6) * 12}px`;
      const artboard = element.getAttribute("data-t3-design-artboard");
      const id = element.getAttribute("data-t3-design-id") || element.id;
      const text =
        element.childElementCount === 0
          ? element.textContent?.trim().replace(/\s+/g, " ").slice(0, 28)
          : null;
      row.textContent =
        artboard ||
        id ||
        (element.hasAttribute("data-t3-design-artboard") ? "Artboard" : text) ||
        element.tagName.toLowerCase();
      row.title = `${element.tagName.toLowerCase()}${id ? ` · ${id}` : ""}`;
      row.setAttribute("aria-selected", String(element === selected));
      row.addEventListener("click", () => selectElement(element));
      layers.appendChild(row);
      for (const child of element.children) append(child, depth + 1);
    };
    for (const element of document.body.children) append(element, 0);
  }

  const selectElement = (element: Element | null, persist = true): void => {
    document
      .querySelectorAll(`[${FOCUS_ATTRIBUTE}]`)
      .forEach((candidate) => candidate.removeAttribute(FOCUS_ATTRIBUTE));
    selected = element instanceof HTMLElement || element instanceof SVGElement ? element : null;
    const existingId = selected?.getAttribute("data-t3-design-id");
    if (
      selected &&
      (!existingId ||
        document.querySelectorAll(`[data-t3-design-id="${CSS.escape(existingId)}"]`).length > 1)
    ) {
      selected.setAttribute("data-t3-design-id", nextId());
    }
    selected?.setAttribute(FOCUS_ATTRIBUTE, "true");
    refreshSelection();
    refreshLayers();
    if (persist) scheduleSave();
  };

  const attachSelection = (): void => {
    if (!selected) return;
    const id = selected.getAttribute("data-t3-design-id");
    if (!id) return;
    const rect = selected.getBoundingClientRect();
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    save(
      createDesignSelectionAnnotation({
        id,
        pageUrl: location.href,
        pageTitle: document.title?.trim() || null,
        tagName: selected.tagName.toLowerCase(),
        selector: `[data-t3-design-id="${CSS.escape(id)}"]`,
        htmlPreview: selected.outerHTML.slice(0, 4_000),
        styles: selected.getAttribute("style") ?? "",
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        createdAt: new Date().toISOString(),
      }),
    );
    attach.textContent = "Attached";
    window.setTimeout(() => {
      attach.textContent = "Attach element";
    }, 900);
  };

  const commitElementState = (element: HTMLElement | SVGElement, before: ElementState): void => {
    const after = stateOf(element);
    if (statesMatch(before, after)) return;
    pushHistory({
      undo: () => applyState(element, before),
      redo: () => applyState(element, after),
    });
    refreshLayers();
    scheduleSave();
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

  const button = (label: string, action: () => void, parent: HTMLElement): HTMLButtonElement => {
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
    element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
    return element;
  };

  const setTool = (next: Tool): void => {
    tool = next;
    for (const [candidate, element] of toolButtons) {
      element.setAttribute("aria-pressed", String(candidate === tool));
    }
    document.documentElement.style.cursor = editorOpen && tool !== "select" ? "crosshair" : "";
    if (tool !== "select") hover.style.display = "none";
  };

  for (const [value, label, icon] of [
    ["select", "Select", '<path d="m5 3 12 8-5.5 1.5L9 18 5 3Z"/>'],
    ["draw", "Draw", '<path d="M4 18c4-9 8-3 16-12"/>'],
    ["arrow", "Arrow", '<path d="M5 19 19 5M10 5h9v9"/>'],
    ["box", "Box", '<rect x="4" y="4" width="16" height="16" rx="2"/>'],
    ["circle", "Circle", '<circle cx="12" cy="12" r="8"/>'],
    ["highlight", "Highlight", '<path d="m5 15 8-8 4 4-8 8H5v-4ZM15 5l4 4"/>'],
  ] as const) {
    const element = iconButton(label, icon, () => setTool(value));
    element.setAttribute("aria-pressed", "false");
    toolButtons.set(value, element);
  }

  const attach = button("Attach element", attachSelection, actions);
  attach.className = "attach";
  const undo = button("Undo", () => runHistory(-1), actions);
  const redo = button("Redo", () => runHistory(1), actions);

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
    layer.style.height = `${Math.max(document.documentElement.scrollHeight, window.innerHeight)}px`;
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

  const addText = (note = false): void => {
    const x =
      window.scrollX +
      Math.max(24, document.documentElement.getBoundingClientRect().width / 2 - 90);
    const y = window.scrollY + Math.max(70, window.innerHeight / 2 - 40);
    const element = baseObject(note ? "note" : "text", x, y);
    element.textContent = note ? "Add a note" : "Edit text";
    element.style.cssText += note
      ? ";width:180px;min-height:90px;padding:14px;border-radius:10px;background:#fef08a;color:#422006;box-shadow:0 8px 20px rgba(0,0,0,.15)"
      : ";padding:6px 8px;color:#111;font:600 18px/1.3 system-ui;background:transparent";
    addObject(element);
  };

  iconButton("Text", '<path d="M5 5h14M12 5v14M8 19h8"/>', () => addText());
  iconButton("Note", '<path d="M5 5h14v11H9l-4 4V5Z"/>', () => addText(true));

  const findArtboard = (element: Element): Element | null => {
    const marked = element.closest(ARTBOARD_SELECTOR);
    if (marked) return marked;
    let candidate = element;
    while (candidate.parentElement && candidate.parentElement !== document.body) {
      candidate = candidate.parentElement;
    }
    return candidate.hasAttribute(OBJECT_ATTRIBUTE) ? null : candidate;
  };

  const choose = button(
    "Choose",
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
    actions,
  );

  const remove = button(
    "Delete",
    () => {
      const element = selected;
      const parent = element?.parentNode;
      if (!element || !parent) return;
      const next = element.nextSibling;
      const detach = (): void => {
        if (selected === element) selectElement(null);
        element.removeAttribute(FOCUS_ATTRIBUTE);
        element.remove();
        refreshLayers();
      };
      detach();
      pushHistory({
        undo: () => parent.insertBefore(element, next?.parentNode === parent ? next : null),
        redo: detach,
      });
      scheduleSave();
    },
    actions,
  );

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
  const sizingSection = section("Sizing");
  field("Width", width, sizingSection);
  field("Height", height, sizingSection);
  const positionSection = section("Position");
  field("Mode", positionMode, positionSection);
  field("X", xValue, positionSection);
  field("Y", yValue, positionSection);
  field("Z-index", zIndex, positionSection);
  const layoutSection = section("Content layout");
  field("Layout", displayMode, layoutSection);
  field("Direction", direction, layoutSection);
  field("Gap", gap, layoutSection);
  field("Align", align, layoutSection);
  field("Justify", justify, layoutSection);
  field("Wrap", wrap, layoutSection);
  field("Padding", padding, layoutSection);
  field("Margin", margin, layoutSection);
  const appearanceSection = section("Appearance");
  field("Background", colorControl(fill, fillText), appearanceSection);
  field("Radius", radius, appearanceSection);
  field("Overflow", overflow, appearanceSection);
  field("Opacity %", opacity, appearanceSection);
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

  const bindField = (
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    update: (element: HTMLElement | SVGElement, value: string) => void,
  ): void => {
    let target: HTMLElement | SVGElement | null = null;
    let before: ElementState | null = null;
    input.addEventListener("focus", () => {
      target = selected;
      before = target ? stateOf(target) : null;
    });
    input.addEventListener("input", () => {
      if (!target || target !== selected) return;
      update(target, input.value);
      refreshSelection();
      scheduleSave();
    });
    input.addEventListener("change", () => {
      if (target && before) commitElementState(target, before);
      target = null;
      before = null;
    });
  };

  bindField(textValue, (element, value) => {
    if (element.childElementCount === 0) element.textContent = value;
  });
  bindField(fill, (element, value) => {
    fillText.value = value;
    element.style.setProperty("background-color", value);
  });
  bindField(fillText, (element, value) => {
    if (/^#[0-9a-f]{6}$/i.test(value)) fill.value = value;
    element.style.setProperty("background-color", value);
  });
  bindField(color, (element, value) => {
    colorText.value = value;
    element.style.setProperty("color", value);
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
  bindField(opacity, (element, value) =>
    element.style.setProperty("opacity", String(Number(value) / 100)),
  );
  bindField(borderWidth, (element, value) =>
    element.style.setProperty("border-width", `${value}px`),
  );
  bindField(borderStyle, (element, value) => element.style.setProperty("border-style", value));
  bindField(borderColor, (element, value) => {
    borderColorText.value = value;
    element.style.setProperty("border-color", value);
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
        window.setTimeout(() => {
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
  const formatButton = (label: string, title: string, command: string): void => {
    const control = document.createElement("button");
    control.type = "button";
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
    ["B", "Bold", "bold"],
    ["I", "Italic", "italic"],
    ["U", "Underline", "underline"],
    ["•", "Bulleted list", "insertUnorderedList"],
    ["1.", "Numbered list", "insertOrderedList"],
    ["Link", "Add link", "createLink"],
  ] as const)
    formatButton(label, title, command);

  for (const direction of ["nw", "ne", "sw", "se"]) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = `handle ${direction}`;
    handle.setAttribute("aria-label", `Resize ${direction}`);
    handle.addEventListener("pointerdown", (event) => {
      if (!selected || event.button !== 0) return;
      handle.setPointerCapture(event.pointerId);
      const rect = selected.getBoundingClientRect();
      const position = positionOf(selected);
      drag = {
        kind: "resize",
        element: selected,
        start: { x: event.clientX, y: event.clientY },
        width: rect.width,
        height: rect.height,
        x: position.x,
        y: position.y,
        direction,
        before: stateOf(selected),
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
      svg.innerHTML = `<path d="${local.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")}" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
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
    svg.innerHTML = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><polygon points="${end.x},${end.y} ${baseX - uy * wing},${baseY + ux * wing} ${baseX + uy * wing},${baseY - ux * wing}" fill="currentColor"/>`;
  };

  const beginCreation = (event: PointerEvent, creationTool: Exclude<Tool, "select">): void => {
    const start = pagePoint(event);
    if (creationTool === "draw" || creationTool === "arrow") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute(OBJECT_ATTRIBUTE, creationTool);
      svg.setAttribute("data-t3-design-id", nextId());
      svg.style.cssText = "position:absolute;pointer-events:auto;overflow:visible;color:#ef4444";
      designLayer().appendChild(svg);
      drag = { kind: "create", tool: creationTool, start, element: svg, points: [start] };
      renderSvg(svg, [start, start], creationTool === "arrow");
      return;
    }
    const element = baseObject(creationTool, start.x, start.y);
    if (creationTool === "box")
      element.style.cssText += ";border:3px solid #ef4444;background:transparent";
    if (creationTool === "circle")
      element.style.cssText +=
        ";border:3px solid #ef4444;border-radius:9999px;background:transparent";
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

  const onPointerDown = (event: PointerEvent): void => {
    if (!editorOpen || annotationActive() || event.button !== 0 || isUiElement(event.target))
      return;
    hideHover();
    if (editingText && event.target instanceof Node && !editingText.contains(event.target))
      finishEditingText?.();
    if (event.target instanceof Element) event.target.setPointerCapture(event.pointerId);
    if (tool !== "select") {
      beginCreation(event, tool);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = targetFromPoint(event.clientX, event.clientY);
    if (target && target === selected) {
      const position = positionOf(selected);
      drag = {
        kind: "move",
        element: selected,
        start: { x: event.clientX, y: event.clientY },
        x: position.x,
        y: position.y,
        before: stateOf(selected),
      };
    } else {
      selectElement(target);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!editorOpen || annotationActive()) return;
    if (!drag) {
      updateHover(event);
      return;
    }
    hideHover();
    if (drag.kind === "move") {
      const x = drag.x + event.clientX - drag.start.x;
      const y = drag.y + event.clientY - drag.start.y;
      drag.element.setAttribute("data-t3-design-x", String(Math.round(x)));
      drag.element.setAttribute("data-t3-design-y", String(Math.round(y)));
      drag.element.style.translate = `${x}px ${y}px`;
    } else if (drag.kind === "resize") {
      const west = drag.direction.includes("w");
      const north = drag.direction.includes("n");
      const nextWidth = Math.max(8, drag.width + (event.clientX - drag.start.x) * (west ? -1 : 1));
      const nextHeight = Math.max(
        8,
        drag.height + (event.clientY - drag.start.y) * (north ? -1 : 1),
      );
      const x = west ? drag.x + drag.width - nextWidth : drag.x;
      const y = north ? drag.y + drag.height - nextHeight : drag.y;
      drag.element.style.minWidth = "0";
      drag.element.style.maxWidth = "none";
      drag.element.style.minHeight = "0";
      drag.element.style.maxHeight = "none";
      drag.element.style.width = `${nextWidth}px`;
      drag.element.style.height = `${nextHeight}px`;
      drag.element.style.translate = `${x}px ${y}px`;
      drag.element.setAttribute("data-t3-design-x", String(Math.round(x)));
      drag.element.setAttribute("data-t3-design-y", String(Math.round(y)));
    } else {
      const end = pagePoint(event);
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

  const onPointerUp = (event: PointerEvent): void => {
    if (!editorOpen || annotationActive() || !drag) return;
    const completed = drag;
    drag = null;
    if (completed.kind === "move" || completed.kind === "resize") {
      commitElementState(completed.element, completed.before);
    } else {
      const rect = completed.element.getBoundingClientRect();
      if (rect.width < MIN_SHAPE_SIZE || rect.height < MIN_SHAPE_SIZE) completed.element.remove();
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

  const editText = (event: MouseEvent): void => {
    if (!editorOpen || annotationActive() || tool !== "select" || isUiElement(event.target)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.childElementCount > 0) return;
    selectElement(target);
    const before = target.innerHTML;
    editingText = target;
    target.setAttribute(DESIGN_EDITING_ATTRIBUTE, "");
    target.contentEditable = "true";
    target.focus();
    const rect = target.getBoundingClientRect();
    textToolbar.style.display = "flex";
    textToolbar.style.left = `${Math.max(8, Math.min(rect.left, document.documentElement.getBoundingClientRect().width - 300))}px`;
    textToolbar.style.top = `${Math.max(8, rect.top - 40)}px`;
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
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!editorOpen || annotationActive()) return;
    const typing =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable);
    if (typing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      runHistory(event.shiftKey ? 1 : -1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Delete" || event.key === "Backspace") remove.click();
    else if (event.key === "Escape" || event.key.toLowerCase() === "v") setTool("select");
    else if (event.key.toLowerCase() === "d") setTool("draw");
    else if (event.key.toLowerCase() === "a") setTool("arrow");
    else if (event.key.toLowerCase() === "b") setTool("box");
    else if (event.key.toLowerCase() === "c") setTool("circle");
    else if (event.key.toLowerCase() === "h") setTool("highlight");
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const preventNavigation = (event: MouseEvent): void => {
    if (editorOpen && !annotationActive() && tool === "select" && !isUiElement(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const setEditorOpen = (active: boolean): void => {
    editorOpen = active;
    toolbar.hidden = !active;
    document.documentElement.toggleAttribute(DESIGN_OPEN_ATTRIBUTE, active && !annotationActive());
    if (!active) discardPendingDesignObject(drag);
    drag = null;
    finishEditingText?.();
    hideHover();
    setTool("select");
    if (!active) {
      selection.style.display = "none";
      textToolbar.style.display = "none";
      return;
    }
    refreshLayers();
    refreshSelection();
  };

  const onDesignEditing = (_event: Electron.IpcRendererEvent, active: unknown): void => {
    if (typeof active === "boolean") setEditorOpen(active);
  };

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
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
  ipcRenderer.on(DESIGN_EDITING_CHANNEL, onDesignEditing);
  const annotationObserver = new MutationObserver(() => {
    const active = annotationActive();
    host.style.display = active ? "none" : "";
    document.documentElement.toggleAttribute(DESIGN_OPEN_ATTRIBUTE, editorOpen && !active);
    if (active) {
      discardPendingDesignObject(drag);
      drag = null;
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
      ipcRenderer.removeListener(DESIGN_EDITING_CHANNEL, onDesignEditing);
    },
    { once: true },
  );
  setEditorOpen(false);
  refreshHistoryButtons();
  selectElement(document.querySelector(`[${FOCUS_ATTRIBUTE}]`), false);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", startDesignEditor, { once: true });
} else {
  startDesignEditor();
}
