import { annotationMetadata, hostCapture } from "./hooks";
import { annotationCanMove, finishActiveDraft, requestAnnotationMove } from "./outside-click";
import { deepElementFromPoint, isAnnotationUi, isElementFixed } from "./dom";
import { identifyElement } from "./identify";
import { readInertiaPage } from "./inertia-page";
import { formatReactHoverPath } from "./react-inspect";
import {
  annotationMode,
  annotations,
  draft,
  finishing,
  hover,
  hoverLabelHidden,
  shakeToken,
  dictationSettings,
} from "./state";
import {
  clearStoredAnnotations,
  isDismissed,
  createAnnotationId,
  loadAnnotations,
  saveAnnotations,
} from "./store";
import { consumeDictationEnter, consumeDictationEscape } from "./dictation-keys";
import { isUnrelatedEditable, isDictationEnabled, mergeTranscript } from "./dictation-settings";
import { stopHostSession } from "./dictation-trigger";
import { resolveAnnotationContext } from "./context";
import { annotationContextFields, annotationPayload } from "./payload";
import { releaseMicrophone, triggersDesktopDictation, warmMicrophone } from "./dictation";
import { captureReady } from "./capture-gate";
import { captureAnnotationScreenshot } from "./screenshot";
import {
  clearSyncedAnnotations,
  deleteSyncedAnnotation,
  fetchAnnotationSync,
  pushAnnotation,
} from "./sync";
import type { Annotation, AnnotationDraft } from "./types";
import { currentBreakpoint, currentScreenSize, currentScrollPosition } from "./viewport";

let currentPathname = "";
let annotationGeneration = 0;
let pendingPlacement: AnnotationDraft | null = null;
let cancelScreenshot: (() => void) | null = null;
const DICTATION_START_LIMIT_MS = 3000;

function persist(): void {
  saveAnnotations(annotations.value, currentPathname || window.location.pathname);
}

export function draftFromPoint(clientX: number, clientY: number): AnnotationDraft | null {
  const element = deepElementFromPoint(clientX, clientY);

  if (!(element instanceof HTMLElement) || isAnnotationUi(element)) {
    return null;
  }

  const { name, path } = identifyElement(element);
  const rect = element.getBoundingClientRect();
  const isFixed = isElementFixed(element);

  const metadata = annotationMetadata({
    element,
    url: window.location.href,
    pathname: window.location.pathname,
  });

  return {
    draftId: createAnnotationId(),
    ...(metadata ? { metadata } : {}),
    x: (clientX / window.innerWidth) * 100,
    y: isFixed ? clientY : clientY + window.scrollY,
    clientX,
    clientY,
    element: name,
    elementPath: path,
    boundingBox: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
    isFixed,
    comment: "",
    targetElement: element,
    url: window.location.href,
    pathname: window.location.pathname,
    screenSize: currentScreenSize(),
    scrollPosition: currentScrollPosition(),
    breakpoint: currentBreakpoint(),
    ...resolveAnnotationContext(element),
  };
}

export function shakeDraft(): void {
  shakeToken.value += 1;
}

function clearPendingPlacement(): void {
  pendingPlacement = null;
  cancelScreenshot?.();
  cancelScreenshot = null;
}

/**
 * A DOM render of a large page takes long enough to delay the popup and the dictation
 * request. Start it only after the popup has painted and its effects have run, when the
 * browser is idle, and attach the image to the draft when it is ready.
 */
function scheduleDraftScreenshot(target: AnnotationDraft): void {
  cancelScreenshot?.();
  const scroll = { x: window.scrollX, y: window.scrollY };
  // A host copies composited pixels off the main thread, so take them now, before the
  // popup paints or the page reacts to the click (closing menus, moving focus).
  if (hostCapture()) {
    cancelScreenshot = null;
    void attachDraftScreenshot(target, scroll);
    return;
  }
  let cancelled = false;
  let idle = 0;
  // Two frames: the popup has painted and its effects, including dictation, have started.
  let frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      void captureReady(DICTATION_START_LIMIT_MS).then(() => {
        if (cancelled) return;
        idle = requestIdle(() => {
          idle = 0;
          cancelScreenshot = null;
          if (draft.value === target) void attachDraftScreenshot(target, scroll);
        });
      });
    });
  });
  cancelScreenshot = () => {
    cancelled = true;
    if (frame) window.cancelAnimationFrame(frame);
    if (idle) cancelIdle(idle);
  };
}

function requestIdle(callback: () => void): number {
  return typeof window.requestIdleCallback === "function"
    ? window.requestIdleCallback(callback, { timeout: 1000 })
    : window.setTimeout(callback, 50);
}

function cancelIdle(handle: number): void {
  if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(handle);
  else window.clearTimeout(handle);
}

async function attachDraftScreenshot(
  target: AnnotationDraft,
  scroll: { x: number; y: number },
): Promise<void> {
  if (target.screenshot) {
    return;
  }

  const screenshot = await captureAnnotationScreenshot(target, scroll);

  if (!screenshot) {
    return;
  }

  target.screenshot = screenshot;

  if (draft.value === target) {
    draft.value = { ...target, screenshot };
  }
}

export function reloadAnnotations(pathname: string = window.location.pathname): void {
  currentPathname = pathname;
  annotations.value = loadAnnotations(pathname);
  clearPendingPlacement();
  finishing.value = [];
  draft.value = null;
  hover.value = null;
}

const visualWaiters = new Map<string, number>();
const VISUAL_APPLY_TIMEOUT_MS = 10_000;

export function applyResolvedAnnotations(
  resolvedIds: string[],
  options: { toById?: Record<string, string>; immediate?: boolean } = {},
): void {
  if (resolvedIds.length === 0) {
    return;
  }

  const ready: string[] = [];

  for (const id of resolvedIds) {
    const annotation = annotations.value.find((item) => item.id === id);
    const to = options.toById?.[id] ?? annotation?.change?.to;

    if (
      options.immediate ||
      !annotation ||
      typeof to !== "string" ||
      to === "" ||
      visualChangeVisible(annotation, to)
    ) {
      ready.push(id);
      continue;
    }

    applyAnnotationStatus([id], "applied");
    applyChangeTargets({ [id]: to });
    waitForVisualApply(annotation, to);
  }

  if (ready.length > 0) {
    removeResolvedPins(ready);
  }
}

function waitForVisualApply(annotation: Annotation, to: string): void {
  if (visualWaiters.has(annotation.id) || typeof window === "undefined") {
    return;
  }

  const started = Date.now();
  const tick = () => {
    if (visualChangeVisible(annotation, to) || Date.now() - started >= VISUAL_APPLY_TIMEOUT_MS) {
      visualWaiters.delete(annotation.id);
      removeResolvedPins([annotation.id]);
      return;
    }

    visualWaiters.set(annotation.id, window.setTimeout(tick, 100));
  };

  visualWaiters.set(annotation.id, window.setTimeout(tick, 50));
}

function visualChangeVisible(annotation: Annotation, to: string): boolean {
  if (typeof document === "undefined") {
    return true;
  }

  return Boolean(resolveTargetElement(annotation)?.classList.contains(to));
}

function removeResolvedPins(resolvedIds: string[]): void {
  const resolved = new Set(resolvedIds);
  const remaining = annotations.value.filter((annotation) => !resolved.has(annotation.id));

  for (const id of resolvedIds) {
    const timer = visualWaiters.get(id);

    if (timer) {
      window.clearTimeout(timer);
      visualWaiters.delete(id);
    }
  }

  if (remaining.length === annotations.value.length) {
    return;
  }

  annotations.value = remaining;
  persist();

  if (draft.value?.annotationId && resolved.has(draft.value.annotationId)) {
    draft.value = null;
  }
}

function applyChangeTargets(toById?: Record<string, string>): void {
  if (!toById || Object.keys(toById).length === 0) {
    return;
  }

  let changed = false;

  annotations.value = annotations.value.map((annotation) => {
    const to = toById[annotation.id];

    if (!to || annotation.change?.to === to) {
      return annotation;
    }

    changed = true;

    return {
      ...annotation,
      change: {
        ...annotation.change,
        to,
      },
    };
  });

  if (changed) {
    persist();
  }
}

export function annotationBelongsToCurrentPage(
  annotation: Pick<Annotation, "url" | "pathname">,
): boolean {
  const pathname =
    currentPathname || (typeof window === "undefined" ? "" : window.location.pathname);
  const href = typeof window === "undefined" ? "" : window.location.href;
  const path = annotation.pathname ?? "";
  const url = annotation.url ?? "";

  if (path === "" && url === "") {
    return true;
  }

  if (path !== "" && path === pathname) {
    return true;
  }

  if (url === "") {
    return false;
  }

  try {
    return new URL(url, href || "http://localhost").pathname === pathname;
  } catch {
    return url.includes(pathname);
  }
}

export function applyCreatedAnnotations(incoming: Annotation[]): void {
  const next = new Map(annotations.value.map((annotation) => [annotation.id, annotation]));
  let changed = false;

  for (const annotation of incoming) {
    if (isDismissed(annotation.id)) continue;
    if (["resolved", "cancelled"].includes(annotation.status ?? "pending")) {
      if (next.delete(annotation.id)) {
        changed = true;
      }

      continue;
    }

    if (!annotationBelongsToCurrentPage(annotation)) {
      continue;
    }

    const existing = next.get(annotation.id);

    if (existing && (existing.revision ?? 0) > (annotation.revision ?? 0)) continue;

    if (
      existing &&
      existing.revision === annotation.revision &&
      existing.number === annotation.number &&
      existing.question === annotation.question &&
      existing.summary === annotation.summary &&
      existing.syncError === annotation.syncError &&
      existing.delivery === annotation.delivery &&
      existing.comment === annotation.comment &&
      existing.status === annotation.status &&
      existing.x === annotation.x &&
      existing.y === annotation.y
    ) {
      continue;
    }

    next.set(
      annotation.id,
      existing
        ? {
            ...existing,
            ...annotation,
            // Server snapshots omit optional fields when a transition clears them.
            question: annotation.question,
            summary: annotation.summary,
            syncError: annotation.syncError,
            delivery: annotation.delivery,
          }
        : annotation,
    );
    changed = true;
  }

  if (!changed) {
    return;
  }

  annotations.value = [...next.values()];
  persist();
}

export function applyInProgressAnnotations(
  inProgressIds: string[],
  toById?: Record<string, string>,
): void {
  applyAnnotationStatus(inProgressIds, "in_progress");
  applyChangeTargets(toById);
}

function applyAnnotationStatus(ids: string[], status: Annotation["status"]): void {
  if (ids.length === 0) {
    return;
  }

  const matching = new Set(ids);
  let changed = false;

  annotations.value = annotations.value.map((annotation) => {
    if (!matching.has(annotation.id) || annotation.status === status) {
      return annotation;
    }

    changed = true;

    return { ...annotation, status };
  });

  if (changed) {
    persist();
  }
}

export async function pullResolvedAnnotations(): Promise<void> {
  const generation = annotationGeneration;
  const sync = await fetchAnnotationSync();
  if (generation !== annotationGeneration) return;
  applyCreatedAnnotations(sync.annotations);
  applyResolvedAnnotations(sync.resolvedIds);
  applyInProgressAnnotations(sync.inProgressIds);
}

export function submitDraft(comment: string, source: AnnotationDraft | null = draft.value): void {
  const current = draft.value;
  const trimmed = comment.trim();

  if (!current || !trimmed || (source && source !== current)) {
    return;
  }

  saveDraft(current, trimmed);
  draft.value = null;
}

function saveDraft(current: AnnotationDraft, trimmed: string): void {
  const saved: Annotation = current.annotationId
    ? {
        ...(annotations.value.find((annotation) => annotation.id === current.annotationId) ?? {
          id: current.annotationId,
          x: current.x,
          y: current.y,
          element: current.element,
          elementPath: current.elementPath,
          timestamp: Date.now(),
        }),
        comment: trimmed,
        ...annotationContextFields(current),
      }
    : {
        id: createAnnotationId(),
        timestamp: Date.now(),
        status: "pending",
        ...annotationPayload(current, trimmed),
      };

  // A draft that finishes after a navigation belongs to its own page, not this one.
  if (annotationBelongsToCurrentPage(saved)) {
    annotations.value = current.annotationId
      ? annotations.value.map((annotation) => (annotation.id === saved.id ? saved : annotation))
      : [...annotations.value, saved];
    persist();
  }
  const generation = annotationGeneration;
  void pushAnnotation(saved).then((updated) => {
    if (generation !== annotationGeneration || !updated) {
      return;
    }

    if (["resolved", "cancelled"].includes(updated.status ?? "pending")) {
      applyResolvedAnnotations([updated.id]);
      return;
    }

    applyCreatedAnnotations([updated]);

    if (updated.status === "in_progress") {
      applyInProgressAnnotations([updated.id]);
    }
  });
}

export function submitDraftAndMove(
  comment: string,
  source: AnnotationDraft,
  next: AnnotationDraft,
): void {
  if (draft.value !== source || !annotationMode.value) return;
  // An empty draft is discarded rather than saved.
  if (comment.trim()) submitDraft(comment, source);
  draft.value = next;
  hover.value = null;
  scheduleDraftScreenshot(next);
}

/**
 * Closes the draft at once and saves it when its dictation session's transcript arrives,
 * merged with the typed text. Without any text, or when the stop fails, nothing is shown.
 */
export function finishDraft(
  source: AnnotationDraft,
  typed: string,
  session: string,
): Promise<void> {
  finishing.value = [...finishing.value, { session, draft: source, typed }];
  if (draft.value === source) {
    clearPendingPlacement();
    draft.value = null;
  }
  return stopHostSession(session)
    .then(
      (text) => mergeTranscript(typed, text),
      () => typed,
    )
    .then((comment) => {
      finishing.value = finishing.value.filter((entry) => entry.session !== session);
      const trimmed = comment.trim();
      if (trimmed) saveDraft(source, trimmed);
    });
}

/** Hands a recording draft to `finishDraft` and opens the next one without waiting. */
export function finishDraftAndMove(
  source: AnnotationDraft,
  typed: string,
  session: string,
  next: AnnotationDraft,
): Promise<void> {
  const open = draft.value === source && annotationMode.value;
  const finished = finishDraft(source, typed, session);
  if (open) {
    draft.value = next;
    hover.value = null;
    scheduleDraftScreenshot(next);
  }
  return finished;
}

function resetPagePins(): void {
  clearPendingPlacement();
  for (const timer of visualWaiters.values()) window.clearTimeout(timer);
  visualWaiters.clear();
  draft.value = null;
  hover.value = null;
  annotations.value = [];
}

/** Removes every annotation of this site from the server, then its pins. */
export function clearAllAnnotations(): void {
  annotationGeneration += 1;
  void clearSyncedAnnotations().then((removed) => {
    if (!removed) return;
    resetPagePins();
    clearStoredAnnotations();
  });
}

/** Like clearAllAnnotations, but only for the annotations of the current page. */
export function clearPageAnnotations(): void {
  const pathname = currentPathname || window.location.pathname;
  annotationGeneration += 1;
  void clearSyncedAnnotations(pathname).then((removed) => {
    if (!removed) return;
    saveAnnotations([], pathname);
    if ((currentPathname || window.location.pathname) === pathname) resetPagePins();
  });
}

export function deleteDraft(): void {
  const id = draft.value?.annotationId;

  if (!id) {
    draft.value = null;
    return;
  }

  void deleteSyncedAnnotation(id).then((removed) => {
    if (!removed) return;
    annotations.value = annotations.value.filter((annotation) => annotation.id !== id);
    persist();
    if (draft.value?.annotationId === id) draft.value = null;
  });
}

export function cancelDraft(): void {
  clearPendingPlacement();
  draft.value = null;
}

function resolveTargetElement(annotation: Annotation): HTMLElement | undefined {
  const box = annotation.boundingBox;

  if (!box || box.width === 0 || box.height === 0) {
    return undefined;
  }

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const element = deepElementFromPoint(centerX, centerY);

  if (!(element instanceof HTMLElement) || isAnnotationUi(element)) {
    return undefined;
  }

  const live = element.getBoundingClientRect();

  if (live.width / box.width < 0.5 || live.height / box.height < 0.5) {
    return undefined;
  }

  return element;
}

export function startEdit(annotation: Annotation, clientX?: number, clientY?: number): void {
  const box = annotation.boundingBox;

  const next: AnnotationDraft = {
    ...annotationContextFields(annotation),
    draftId: createAnnotationId(),
    annotationId: annotation.id,
    x: annotation.x,
    y: annotation.y,
    clientX: clientX ?? (annotation.x / 100) * window.innerWidth,
    clientY: clientY ?? (annotation.isFixed ? annotation.y : annotation.y - window.scrollY),
    element: annotation.element,
    boundingBox: box ?? {
      x: (annotation.x / 100) * window.innerWidth,
      y: annotation.isFixed ? annotation.y : annotation.y - window.scrollY,
      width: 0,
      height: 0,
    },
    isFixed: Boolean(annotation.isFixed),
    comment: annotation.comment,
    targetElement: resolveTargetElement(annotation),
  };
  draft.value = next;
  hover.value = null;
  scheduleDraftScreenshot(next);
}

export function setAnnotationMode(active: boolean): void {
  annotationMode.value = active;
  document.documentElement.classList.toggle("conn-annotating", active);

  if (!active) {
    finishActiveDraft();
    clearPendingPlacement();
    draft.value = null;
    hover.value = null;
    hoverLabelHidden.value = false;
    releaseMicrophone();
    return;
  }

  if (
    !triggersDesktopDictation(dictationSettings.value) &&
    isDictationEnabled(dictationSettings.value) &&
    dictationSettings.value.autoStart !== false
  ) {
    void warmMicrophone();
  }
  warmHostCapture();
  void pullResolvedAnnotations();
}

/** A page's first composited-pixel copy is slow; pay for it now, not on the first click. */
function warmHostCapture(): void {
  const capture = hostCapture();
  if (capture) void capture({ x: 0, y: 0, width: 1, height: 1 }).catch(() => undefined);
}

export function toggleAnnotationMode(): void {
  setAnnotationMode(!annotationMode.value);
}

function consumeAnnotationGesture(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

export function handleDocumentMouseDown(event: MouseEvent): void {
  if (event.button !== 0 || !annotationMode.value) {
    return;
  }

  const pathTarget =
    (event.composedPath()[0] as Element | undefined) ?? (event.target as Element | null);

  if (isAnnotationUi(pathTarget)) {
    return;
  }

  // Host UIs can act on mousedown (for example, list rows that navigate): consume it first.
  consumeAnnotationGesture(event);

  if (draft.value) {
    return;
  }

  // The click copies the screen at once; hiding the label now gives it frames to disappear.
  hoverLabelHidden.value = true;

  const nextDraft = draftFromPoint(event.clientX, event.clientY);

  if (!nextDraft) {
    clearPendingPlacement();
    return;
  }

  // Capturing here would delay the popup; the click schedules it once the popup is open.
  pendingPlacement = nextDraft;
}

export function handleDocumentClick(event: MouseEvent): void {
  const pathTarget =
    (event.composedPath()[0] as Element | undefined) ?? (event.target as Element | null);

  if (isAnnotationUi(pathTarget)) {
    return;
  }

  if (draft.value) {
    consumeAnnotationGesture(event);
    const next = draftFromPoint(event.clientX, event.clientY);
    if (next && requestAnnotationMove(next)) return;
    shakeDraft();
    return;
  }

  if (!annotationMode.value) {
    return;
  }

  consumeAnnotationGesture(event);

  const nextDraft = pendingPlacement ?? draftFromPoint(event.clientX, event.clientY);
  pendingPlacement = null;

  if (!nextDraft) {
    return;
  }

  draft.value = nextDraft;
  hover.value = null;

  if (!nextDraft.screenshot) {
    scheduleDraftScreenshot(nextDraft);
  }
}

export function handleMouseMove(event: MouseEvent): void {
  if (event.buttons === 0 && hoverLabelHidden.value) {
    hoverLabelHidden.value = false;
  }

  if (!annotationMode.value || (draft.value && !annotationCanMove())) {
    hover.value = null;
    return;
  }

  const element = deepElementFromPoint(event.clientX, event.clientY);

  if (!(element instanceof HTMLElement) || isAnnotationUi(element)) {
    hover.value = null;
    return;
  }

  const { name, path } = identifyElement(element);
  const rect = element.getBoundingClientRect();

  hover.value = {
    name,
    path,
    reactComponents: formatReactHoverPath(element, readInertiaPage()?.component),
    rect: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
    cursorX: event.clientX,
    cursorY: event.clientY,
  };
}

export function handleKeyDown(event: KeyboardEvent): void {
  if (event.isComposing) {
    return;
  }

  const shortcut = event.key.toLowerCase();
  if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    (shortcut === "a" || shortcut === "r")
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) {
      if (shortcut === "a") toggleAnnotationMode();
      else clearAllAnnotations();
    }
    return;
  }

  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    if (isUnrelatedEditable(event.target)) {
      return;
    }

    if (consumeDictationEnter()) {
      event.preventDefault();
      event.stopPropagation();
    }

    return;
  }

  if (event.key !== "Escape") {
    return;
  }

  if (consumeDictationEscape()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (draft.value || pendingPlacement) {
    event.preventDefault();
    cancelDraft();
    return;
  }

  if (annotationMode.value) {
    event.preventDefault();
    setAnnotationMode(false);
  }
}

export function handleExternalToolbar(): void {
  if (
    document
      .getElementById("laravel-toolbar-shadow-host")
      ?.classList.contains("toolbar-external-active")
  ) {
    setAnnotationMode(false);
  }
}

export function handleNavigation(): void {
  const pathname = window.location.pathname;
  const pathChanged = pathname !== currentPathname;

  currentPathname = pathname;
  annotations.value = loadAnnotations(pathname);

  if (pathChanged) {
    clearPendingPlacement();
    // Their boxes belong to the old page; finishDraft still saves them.
    finishing.value = [];
    draft.value = null;
    hover.value = null;
  }

  void pullResolvedAnnotations();
}

export function resetAnnotationState(): void {
  for (const timer of visualWaiters.values()) {
    window.clearTimeout(timer);
  }

  visualWaiters.clear();
  setAnnotationMode(false);
  clearPendingPlacement();
  draft.value = null;
  hover.value = null;
  annotations.value = [];
  currentPathname = "";
}
