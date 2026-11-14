// @effect-diagnostics globalDate:off globalTimers:off - This isolated Electron preload does not run inside an Effect runtime.
import { ipcRenderer } from "electron";
import { getElementContext } from "react-grab/primitives";
import type {
  DesktopPreviewAnnotationTheme,
  PickedElementPayload,
  PickedElementStackFrame,
  PreviewAnnotationPayload,
  PreviewAnnotationPoint,
  PreviewAnnotationRect,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
  PreviewAnnotationStyleChange,
  PreviewAnnotationSubmission,
} from "@t3tools/contracts";

import { createAnnotationIdSource } from "./AnnotationIds.ts";
import { resolveAnnotationSubmission } from "./AnnotationKeyboard.ts";
import { createAnnotationEditorPlacement } from "./pickPreloadPlacement.ts";
import { createAnnotationTargets } from "./pickPreloadTargets.ts";
import { createAnnotationStylePanel } from "./pickPreloadStylePanel.ts";
import { previewAnnotationStyles } from "./AnnotationStyles.generated.ts";
import { installRecordingCursor } from "./RecordingCursor.ts";
import { DEFAULT_RECORDING_INPUT_OPTIONS } from "./RecordingInput.ts";
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_SEND_ENABLED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  MOUSE_NAVIGATE_CHANNEL,
  RECORDING_CURSOR_CHANNEL,
  RECORDING_POINTER_CHANNEL,
  RECORDING_KEY_CHANNEL,
  RECORDING_INPUT_CHANNEL,
  RECORDING_CONTROLLER_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";
const OVERLAY_ATTRIBUTE = "data-t3code-annotation-ui";
const INPUT_LAYER_ATTRIBUTE = "data-t3code-annotation-input";
const Z_INDEX_OVERLAY = 2147483646;
const PRIMARY = "var(--t3-primary)";
const PRIMARY_FILL = "color-mix(in srgb, var(--t3-primary) 10%, transparent)";
const MAX_MARQUEE_ELEMENTS = 20;
const ELEMENT_CONTEXT_TIMEOUT_MS = 5_000;
const CONTENT_LAYER_Z_INDEX = 1;
const CHROME_LAYER_Z_INDEX = 10;

let recordingCursor: ReturnType<typeof installRecordingCursor> | null = null;
ipcRenderer.on(
  RECORDING_CURSOR_CHANNEL,
  (_event, active: unknown, inputOptions: unknown, controller: unknown) => {
    if (active === true) {
      const options =
        typeof inputOptions === "object" && inputOptions !== null
          ? {
              showKeyPresses:
                "showKeyPresses" in inputOptions && inputOptions.showKeyPresses === true,
              showMousePresses:
                "showMousePresses" in inputOptions && inputOptions.showMousePresses === true,
            }
          : DEFAULT_RECORDING_INPUT_OPTIONS;
      recordingCursor ??= installRecordingCursor(document, window, options, (input) =>
        ipcRenderer.send(RECORDING_INPUT_CHANNEL, input),
      );
      recordingCursor.setTheme(annotationTheme);
      if (controller === "agent" || controller === "human" || controller === "none")
        recordingCursor.setController(controller);
    } else {
      recordingCursor?.dispose();
      recordingCursor = null;
    }
  },
);
ipcRenderer.on(RECORDING_CONTROLLER_CHANNEL, (_event, controller: unknown, point: unknown) => {
  const humanPoint =
    typeof point === "object" &&
    point !== null &&
    "x" in point &&
    typeof point.x === "number" &&
    Number.isFinite(point.x) &&
    "y" in point &&
    typeof point.y === "number" &&
    Number.isFinite(point.y)
      ? { x: point.x, y: point.y }
      : undefined;
  if (controller === "agent" || controller === "human" || controller === "none")
    recordingCursor?.setController(controller, humanPoint);
});
ipcRenderer.on(RECORDING_KEY_CHANNEL, (_event, input: unknown) => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("key" in input) ||
    typeof input.key !== "string"
  )
    return;
  recordingCursor?.keyPress({
    key: input.key,
    metaKey: "metaKey" in input && input.metaKey === true,
    ctrlKey: "ctrlKey" in input && input.ctrlKey === true,
    altKey: "altKey" in input && input.altKey === true,
    shiftKey: "shiftKey" in input && input.shiftKey === true,
  });
});
ipcRenderer.on(RECORDING_POINTER_CHANNEL, (_event, point: unknown) => {
  if (
    typeof point === "object" &&
    point !== null &&
    "x" in point &&
    typeof point.x === "number" &&
    Number.isFinite(point.x) &&
    "y" in point &&
    typeof point.y === "number" &&
    Number.isFinite(point.y)
  )
    recordingCursor?.move(
      { x: point.x, y: point.y },
      "phase" in point && point.phase === "click" ? "click" : "move",
    );
});

import {
  applyAnnotationTheme,
  createBox,
  createButton,
  createField,
  createLabel,
  createStyleSection,
  createUnitControl,
  createUnitInput,
  HTML_PREVIEW_MAX_CHARS,
  isAnnotationNode,
  isUsableRect,
  nextId,
  normalizeRect,
  pathFromPoints,
  pickFromPoint,
  positionBox,
  rectFromDomRect,
  strokeBounds,
  styleControl,
  toStackFrame,
  unionRects,
  updateSelectedVisual,
  visibleElementRect,
  withCaptureTimeout,
  type AnnotationSession,
  type AnnotationTool,
  type SelectedElement,
  captureElement,
  installPickUiBridge,
} from "./pickPreloadUi.ts";

let activeSession: AnnotationSession | null = null;
let annotationTheme: DesktopPreviewAnnotationTheme | null = null;

installPickUiBridge({
  send: (channel, payload) => ipcRenderer.send(channel, payload),
});

function startAnnotation(sendEnabled: boolean): void {
  activeSession?.teardown(false);
  let finished = false;
  const host = document.createElement("div");
  host.setAttribute(OVERLAY_ATTRIBUTE, "");
  host.setAttribute("dir", "ltr");
  host.style.cssText = `position:fixed;inset:0;z-index:${Z_INDEX_OVERLAY};pointer-events:none`;
  applyAnnotationTheme(host, annotationTheme);
  const shadowRoot = host.attachShadow({ mode: "closed" });
  const themeStyle = document.createElement("style");
  themeStyle.textContent = previewAnnotationStyles;
  shadowRoot.appendChild(themeStyle);

  const root = document.createElement("div");
  root.setAttribute(OVERLAY_ATTRIBUTE, "");
  root.setAttribute("dir", "ltr");
  root.className = "fixed inset-0 font-sans text-foreground";
  root.style.cssText = "pointer-events:none";
  const cursorStyle = document.createElement("style");
  cursorStyle.setAttribute(OVERLAY_ATTRIBUTE, "");
  cursorStyle.textContent = `html[data-t3code-annotation-tool] body, html[data-t3code-annotation-tool] body * { cursor: crosshair !important; } [${OVERLAY_ATTRIBUTE}], [${OVERLAY_ATTRIBUTE}] * { cursor: default !important; } [${OVERLAY_ATTRIBUTE}] input[type=number]::-webkit-inner-spin-button, [${OVERLAY_ATTRIBUTE}] input[type=number]::-webkit-outer-spin-button { appearance:none; margin:0; }`;
  document.documentElement.appendChild(cursorStyle);
  shadowRoot.appendChild(root);

  const hoverOutline = createBox(PRIMARY, PRIMARY_FILL);
  const marqueeBox = createBox(PRIMARY, PRIMARY_FILL);
  root.append(hoverOutline, marqueeBox);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute(OVERLAY_ATTRIBUTE, "");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
  svg.style.cssText = "position:fixed;inset:0;overflow:visible;pointer-events:none";
  svg.style.zIndex = String(CONTENT_LAYER_Z_INDEX);
  root.appendChild(svg);

  const toolbar = document.createElement("div");
  toolbar.setAttribute(OVERLAY_ATTRIBUTE, "");
  toolbar.className =
    "pointer-events-auto fixed top-2.5 left-1/2 flex -translate-x-1/2 gap-0.5 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl";
  toolbar.style.zIndex = String(CHROME_LAYER_Z_INDEX);
  root.appendChild(toolbar);

  const editor = document.createElement("div");
  editor.setAttribute(OVERLAY_ATTRIBUTE, "");
  editor.className =
    "pointer-events-auto fixed hidden max-h-[calc(100vh-16px)] w-[min(360px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-border bg-popover/96 text-popover-foreground shadow-2xl backdrop-blur-xl";
  editor.style.zIndex = String(CHROME_LAYER_Z_INDEX);
  root.appendChild(editor);

  const composerRow = document.createElement("div");
  composerRow.className = "flex items-start gap-2 p-2";

  const adjust = createButton("", "Expand annotation editor");
  adjust.setAttribute("aria-label", "Expand annotation editor");
  adjust.setAttribute("aria-expanded", "false");
  adjust.className +=
    " h-8 w-8 shrink-0 bg-muted p-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground";
  adjust.innerHTML =
    '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12M7 3v4M13 8v4M9 13v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  composerRow.appendChild(adjust);

  const comment = document.createElement("textarea");
  comment.placeholder = "Describe the change…";
  comment.setAttribute("dir", "auto");
  comment.rows = 1;
  comment.className =
    "min-h-8 max-h-24 min-w-0 flex-1 resize-none overflow-y-hidden border-0 border-b border-b-transparent bg-transparent px-0 py-1.5 font-sans text-sm leading-5 text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-b-primary focus:outline-none focus:ring-0";
  composerRow.appendChild(comment);

  const dragHandle = document.createElement("button");
  dragHandle.type = "button";
  dragHandle.textContent = "⠿";
  dragHandle.title = "Drag annotation editor";
  dragHandle.className =
    "hidden h-8 w-6 shrink-0 cursor-grab select-none border-0 bg-transparent p-0 font-sans text-lg font-bold leading-5 text-muted-foreground";
  composerRow.appendChild(dragHandle);

  const submit = createButton("Attach", "Attach annotation and screenshot (Enter)");
  const updateSendHint = () => {
    submit.title = sendEnabled
      ? "Attach annotation and screenshot (Enter). Send with Cmd/Ctrl+Enter."
      : "Attach annotation and screenshot (Enter)";
  };
  updateSendHint();
  submit.className +=
    " h-8 shrink-0 border-primary bg-primary px-3 text-primary-foreground shadow-sm hover:bg-primary/90";
  composerRow.appendChild(submit);
  editor.appendChild(composerRow);

  const stylePanel = document.createElement("div");
  stylePanel.className =
    "hidden max-h-[min(176px,calc(100vh-180px))] overflow-auto border-t border-border bg-muted/40 px-3";
  editor.appendChild(stylePanel);

  const selected = new Map<Element, SelectedElement>();
  const regions: PreviewAnnotationRegionTarget[] = [];
  const strokes: PreviewAnnotationStrokeTarget[] = [];
  const styleChanges = new Map<string, PreviewAnnotationStyleChange>();
  const toolButtons = new Map<AnnotationTool, HTMLButtonElement>();
  // Chromium draws a PDF in its own viewer frame, so pointer and key input over it
  // never reaches this document. A transparent layer above the viewer catches the
  // pointer and takes focus for Escape and the tool keys. A PDF has no elements to
  // select, so it starts on Region.
  const isPdf = document.contentType === "application/pdf";
  const inputLayer = isPdf ? document.createElement("div") : null;
  if (inputLayer) {
    inputLayer.setAttribute(INPUT_LAYER_ATTRIBUTE, "");
    inputLayer.tabIndex = -1;
    inputLayer.style.cssText = `position:fixed;inset:0;z-index:${Z_INDEX_OVERLAY - 1};cursor:crosshair;outline:none`;
  }
  let tool: AnnotationTool = isPdf ? "marquee" : "select";
  let dragStart: PreviewAnnotationPoint | null = null;
  let activeStroke: { target: PreviewAnnotationStrokeTarget; path: SVGPathElement } | null = null;
  let pendingCapture = false;
  let editorWasShown = false;
  let editorDrag: { pointerId: number; offsetX: number; offsetY: number } | null = null;

  const resizeComment = (): void => {
    const maxHeight = 96;
    comment.style.height = "auto";
    const nextHeight = Math.min(comment.scrollHeight, maxHeight);
    comment.style.height = `${nextHeight}px`;
    comment.style.overflowY = comment.scrollHeight > maxHeight ? "auto" : "hidden";
    placement.queueEditorLayout();
  };
  comment.addEventListener("input", resizeComment);

  const updateStatus = (): void => {
    const hasTargets = selected.size > 0 || regions.length > 0 || strokes.length > 0;
    editor.style.display = hasTargets ? "flex" : "none";
    submit.disabled = !hasTargets;
    submit.style.opacity = hasTargets ? "1" : "0.45";
    adjust.disabled = !hasTargets;
    stylePanel.style.display = placement.expanded && selected.size > 0 ? "grid" : "none";
    placement.queueEditorLayout();
    if (hasTargets && !editorWasShown) {
      editorWasShown = true;
      window.setTimeout(() => comment.focus({ preventScroll: true }), 0);
    }
  };

  const refreshToolButtons = (): void => {
    for (const [candidate, button] of toolButtons) {
      const active = candidate === tool;
      button.classList.toggle("bg-primary/10", active);
      button.classList.toggle("text-primary", active);
      button.classList.toggle("text-foreground", !active);
    }
    if (tool !== "select") hoverOutline.style.display = "none";
    if (tool !== "marquee") marqueeBox.style.display = "none";
    document.documentElement.setAttribute("data-t3code-annotation-tool", tool);
  };

  const removeSelected = (target: SelectedElement): void => {
    if (target.element instanceof HTMLElement || target.element instanceof SVGElement) {
      for (const [property, baseline] of target.baselineStyles) {
        if (baseline) target.element.style.setProperty(property, baseline);
        else target.element.style.removeProperty(property);
      }
    }
    selected.delete(target.element);
    target.outline.remove();
    target.label.remove();
    for (const [key, change] of styleChanges) {
      if (change.targetId === target.id) styleChanges.delete(key);
    }
    updateStatus();
  };

  const addSelected = (element: Element): void => {
    if (selected.has(element)) return;
    const target: SelectedElement = {
      id: nextId("element"),
      element,
      outline: createBox(PRIMARY, PRIMARY_FILL),
      label: createLabel(),
      baselineStyles: new Map(),
    };
    selected.set(element, target);
    root.append(target.outline, target.label);
    updateSelectedVisual(target);
    updateStatus();
    if (placement.expanded) {
      stylePanel.style.display = "grid";
      syncStyleControls();
    }
  };

  const toggleSelected = (element: Element, additive: boolean): void => {
    const existing = selected.get(element);
    if (existing) {
      removeSelected(existing);
      return;
    }
    if (!additive) {
      for (const target of Array.from(selected.values())) removeSelected(target);
    }
    addSelected(element);
  };

  const setStyleForSelected = (property: string, value: string): void => {
    for (const target of selected.values()) {
      if (!(target.element instanceof HTMLElement || target.element instanceof SVGElement))
        continue;
      if (!target.baselineStyles.has(property)) {
        target.baselineStyles.set(property, target.element.style.getPropertyValue(property));
      }
      const key = `${target.id}:${property}`;
      const previousValue =
        styleChanges.get(key)?.previousValue ??
        getComputedStyle(target.element).getPropertyValue(property).trim();
      target.element.style.setProperty(property, value, "important");
      styleChanges.set(key, {
        targetId: target.id,
        selector: null,
        property,
        previousValue,
        value,
      });
      updateSelectedVisual(target);
    }
  };

  const { syncStyleControls } = createAnnotationStylePanel({
    stylePanel,
    selected,
    setStyleForSelected,
  });

  const tools: ReadonlyArray<[AnnotationTool, string, string]> = [
    ["select", "Select", "Select elements (V)"],
    ["marquee", "Region", "Draw a region or marquee-select elements (R)"],
    ["draw", "Draw", "Draw freehand (D)"],
    ["erase", "Erase", "Remove an annotation target (E)"],
  ];
  for (const [candidate, label, title] of tools) {
    const button = createButton(label, title);
    button.className += " h-8 px-2.5 text-sm";
    button.addEventListener("click", () => {
      tool = candidate;
      refreshToolButtons();
    });
    toolButtons.set(candidate, button);
    toolbar.appendChild(button);
  }

  const placement = createAnnotationEditorPlacement({
    editor,
    stylePanel,
    dragHandle,
    adjust,
    selected,
    regions,
    strokes,
    syncStyleControls: () => syncStyleControls(),
  });

  const onEditorPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !placement.expanded) return;
    const rect = editor.getBoundingClientRect();
    editorDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    dragHandle.setPointerCapture(event.pointerId);
    dragHandle.style.cursor = "grabbing";
    event.preventDefault();
    event.stopPropagation();
  };

  const onEditorPointerMove = (event: PointerEvent): void => {
    if (!editorDrag || editorDrag.pointerId !== event.pointerId) return;
    placement.applyEditorPosition({
      left: event.clientX - editorDrag.offsetX,
      top: event.clientY - editorDrag.offsetY,
    });
    event.preventDefault();
    event.stopPropagation();
  };

  const onEditorPointerUp = (event: PointerEvent): void => {
    if (!editorDrag || editorDrag.pointerId !== event.pointerId) return;
    editorDrag = null;
    dragHandle.style.cursor = "grab";
    if (dragHandle.hasPointerCapture(event.pointerId))
      dragHandle.releasePointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  dragHandle.addEventListener("pointerdown", onEditorPointerDown);
  dragHandle.addEventListener("pointermove", onEditorPointerMove);
  dragHandle.addEventListener("pointerup", onEditorPointerUp);
  dragHandle.addEventListener("pointercancel", onEditorPointerUp);

  const repaint = (): void => {
    for (const target of selected.values()) updateSelectedVisual(target);
    placement.queueEditorLayout();
  };
  // A scrollbar appearing narrows the viewport without a window resize.
  const rootResizeObserver = new ResizeObserver(repaint);

  const { removeTargetAtPoint, selectElementsInRect } = createAnnotationTargets({
    selected,
    regions,
    strokes,
    root,
    svg,
    removeSelected,
    addSelected,
    updateStatus,
  });

  const clearHoverOutline = (): void => {
    hoverOutline.style.display = "none";
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (isAnnotationNode(event.target as Element)) {
      clearHoverOutline();
      return;
    }
    if (tool === "select" && dragStart === null) {
      const target = pickFromPoint(event.clientX, event.clientY);
      if (target) positionBox(hoverOutline, visibleElementRect(target));
      else clearHoverOutline();
      return;
    }
    clearHoverOutline();
    if (tool === "marquee" && dragStart) {
      positionBox(
        marqueeBox,
        normalizeRect(dragStart.x, dragStart.y, event.clientX, event.clientY),
      );
      return;
    }
    if (tool === "draw" && activeStroke) {
      activeStroke.target.points = [
        ...activeStroke.target.points,
        { x: event.clientX, y: event.clientY },
      ];
      activeStroke.target.bounds = strokeBounds(
        activeStroke.target.points,
        activeStroke.target.width,
      );
      activeStroke.path.setAttribute("d", pathFromPoints(activeStroke.target.points));
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || isAnnotationNode(event.target as Element)) return;
    event.preventDefault();
    event.stopPropagation();
    if (tool === "select") {
      const target = pickFromPoint(event.clientX, event.clientY);
      if (target) toggleSelected(target, event.shiftKey);
      return;
    }
    if (tool === "erase") {
      removeTargetAtPoint(event.clientX, event.clientY);
      return;
    }
    dragStart = { x: event.clientX, y: event.clientY };
    if (tool === "draw") {
      const stroke: PreviewAnnotationStrokeTarget = {
        id: nextId("stroke"),
        color: annotationTheme?.primary ?? "#2563eb",
        width: 4,
        points: [dragStart],
        bounds: { x: dragStart.x, y: dragStart.y, width: 1, height: 1 },
      };
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(OVERLAY_ATTRIBUTE, "");
      path.setAttribute("data-stroke-id", stroke.id);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke.color);
      path.setAttribute("stroke-width", String(stroke.width));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      activeStroke = { target: stroke, path };
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!dragStart) return;
    event.preventDefault();
    event.stopPropagation();
    if (tool === "marquee") {
      const rect = normalizeRect(dragStart.x, dragStart.y, event.clientX, event.clientY);
      marqueeBox.style.display = "none";
      if (isUsableRect(rect)) {
        const found = selectElementsInRect(rect);
        if (found === 0) {
          const region: PreviewAnnotationRegionTarget = { id: nextId("region"), rect };
          regions.push(region);
          const regionBox = createBox(
            PRIMARY,
            "color-mix(in srgb, var(--t3-primary) 6%, transparent)",
          );
          regionBox.setAttribute("data-region-id", region.id);
          positionBox(regionBox, rect);
          root.appendChild(regionBox);
        }
      }
    } else if (tool === "draw" && activeStroke) {
      if (activeStroke.target.points.length > 1) strokes.push(activeStroke.target);
      else activeStroke.path.remove();
      activeStroke = null;
    }
    dragStart = null;
    updateStatus();
  };

  const onClick = (event: MouseEvent): void => {
    if (isAnnotationNode(event.target as Element)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerOut = (event: PointerEvent): void => {
    if (event.relatedTarget === null) clearHoverOutline();
  };

  const onWindowBlur = (): void => {
    clearHoverOutline();
  };

  const restoreStyles = (): void => {
    for (const target of selected.values()) {
      if (!(target.element instanceof HTMLElement || target.element instanceof SVGElement))
        continue;
      for (const [property, baseline] of target.baselineStyles) {
        if (baseline) target.element.style.setProperty(property, baseline);
        else target.element.style.removeProperty(property);
      }
    }
  };

  const teardown = (notifyMain: boolean): void => {
    if (finished) return;
    finished = true;
    rootResizeObserver.disconnect();
    restoreStyles();
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointerout", onPointerOut, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", repaint, true);
    window.removeEventListener("resize", repaint);
    dragHandle.removeEventListener("pointerdown", onEditorPointerDown);
    dragHandle.removeEventListener("pointermove", onEditorPointerMove);
    dragHandle.removeEventListener("pointerup", onEditorPointerUp);
    dragHandle.removeEventListener("pointercancel", onEditorPointerUp);
    placement.cancelLayout();
    ipcRenderer.off(CANCEL_PICK_CHANNEL, onCancel);
    ipcRenderer.off(ANNOTATION_CAPTURED_CHANNEL, onCaptured);
    document.documentElement.removeAttribute("data-t3code-annotation-tool");
    cursorStyle.remove();
    inputLayer?.remove();
    host.remove();
    activeSession = null;
    if (notifyMain) ipcRenderer.send(ELEMENT_PICKED_CHANNEL, null);
  };

  const onCancel = (): void => teardown(false);
  const onCaptured = (): void => teardown(false);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isAnnotationNode(event.target as Element) && event.key !== "Escape") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      teardown(true);
      return;
    }
    if (event.key === "v") tool = "select";
    else if (event.key === "r") tool = "marquee";
    else if (event.key === "d") tool = "draw";
    else if (event.key === "e") tool = "erase";
    else return;
    refreshToolButtons();
  };

  const submitAnnotation = (submission: PreviewAnnotationSubmission): void => {
    if (submission === "send" && !sendEnabled) return;
    if (pendingCapture || (selected.size === 0 && regions.length === 0 && strokes.length === 0))
      return;
    pendingCapture = true;
    submit.disabled = true;
    submit.textContent = "Capturing…";
    // Snapshot the submitted comment before context lookup lets the user edit it.
    const submittedComment = comment.value.trim();
    const submittedRegions = [...regions];
    const submittedStrokes = [...strokes];
    const submittedStyleChanges = Array.from(styleChanges.values(), (change) => ({ ...change }));
    void Promise.all(
      Array.from(selected.values()).map(async (target) => {
        const element = await captureElement(target.element);
        for (const change of submittedStyleChanges) {
          if (change.targetId === target.id && element.selector !== null) {
            change.selector = element.selector;
          }
        }
        return {
          id: target.id,
          element,
          rect: rectFromDomRect(target.element.getBoundingClientRect()),
        };
      }),
    )
      .then((elements) => {
        // A late submit must not reach a replacement pick's listener.
        if (finished) return;
        const annotation: PreviewAnnotationPayload = {
          id: nextId("annotation"),
          pageUrl: location.href,
          pageTitle: document.title?.trim() || null,
          comment: submittedComment,
          elements,
          regions: submittedRegions,
          strokes: submittedStrokes,
          styleChanges: submittedStyleChanges,
          screenshot: null,
          createdAt: new Date().toISOString(),
        };
        editor.style.display = "none";
        toolbar.style.display = "none";
        hoverOutline.style.display = "none";
        const screenshotRect = unionRects([
          ...elements.map((target) => target.rect),
          ...submittedRegions.map((region) => region.rect),
          ...submittedStrokes.map((stroke) => stroke.bounds),
        ]);
        ipcRenderer.send(
          ELEMENT_PICKED_CHANNEL,
          annotation,
          screenshotRect,
          submission === "send" && !sendEnabled ? "attach" : submission,
          // Main crops a viewport capture, whose pixels are CSS px × this.
          window.devicePixelRatio,
        );
      })
      .catch(() => {
        teardown(true);
      });
  };
  submit.addEventListener("click", () => submitAnnotation("attach"));
  root.addEventListener("keydown", (event) => {
    const submission =
      event.target === comment ? resolveAnnotationSubmission(event, sendEnabled) : null;
    // Bubble phase lets editor inputs handle events before hiding them from the page.
    event.stopImmediatePropagation();
    if (!submission) return;
    event.preventDefault();
    submitAnnotation(submission);
  });

  window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
  window.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
  window.addEventListener("pointerout", onPointerOut, { capture: true, passive: true });
  window.addEventListener("click", onClick, { capture: true, passive: false });
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("keydown", onKeyDown, { capture: true });
  window.addEventListener("scroll", repaint, { capture: true, passive: true });
  window.addEventListener("resize", repaint, { passive: true });
  ipcRenderer.on(CANCEL_PICK_CHANNEL, onCancel);
  ipcRenderer.on(ANNOTATION_CAPTURED_CHANNEL, onCaptured);
  if (inputLayer) {
    document.documentElement.appendChild(inputLayer);
    inputLayer.focus({ preventScroll: true });
  }
  document.documentElement.appendChild(host);
  rootResizeObserver.observe(document.documentElement);
  refreshToolButtons();
  updateStatus();
  activeSession = {
    teardown,
    applyTheme: (theme) => applyAnnotationTheme(host, theme),
    setSendEnabled: (enabled) => {
      sendEnabled = enabled;
      updateSendHint();
    },
  };
}

ipcRenderer.on(
  START_PICK_CHANNEL,
  (_event, theme: DesktopPreviewAnnotationTheme | undefined, sendEnabled?: boolean) => {
    if (theme) annotationTheme = theme;
    startAnnotation(sendEnabled === true);
  },
);
ipcRenderer.on(ANNOTATION_SEND_ENABLED_CHANNEL, (_event, enabled: boolean) => {
  activeSession?.setSendEnabled(enabled === true);
});
ipcRenderer.on(ANNOTATION_THEME_CHANNEL, (_event, theme: DesktopPreviewAnnotationTheme) => {
  annotationTheme = theme;
  recordingCursor?.setTheme(theme);
  activeSession?.applyTheme(theme);
});
ipcRenderer.on(CANCEL_PICK_CHANNEL, () => activeSession?.teardown(false));
