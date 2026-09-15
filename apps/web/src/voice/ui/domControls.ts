/**
 * Client-local UI control enumeration and activation for the voice tools.
 *
 * The attached web client owns UI execution: this module scans the live DOM
 * of the window it runs in for activatable controls (buttons, links, menu
 * items, tabs, form controls), assigns each element a stable opaque id, and
 * performs a real activation (pointer + click sequence) at click time.
 *
 * Identity is per element, never per description: the registry hands the
 * same element the same id across listings and re-resolves an id to the
 * element itself at click time. A control that disappeared between listing
 * and clicking is reported stale and requires relisting; a surviving
 * same-named sibling is never retargeted, and the listed name and occurrence
 * are context for the model, never the click address. There is no
 * per-button registry to maintain: any control with a supported role is
 * discoverable, including disabled and hidden ones (state-marked), and open
 * menus and dialogs contribute their items like any other visible control.
 */
import type {
  VoiceClickControlInput,
  VoiceClickControlOutput,
  VoiceListControlsInput,
  VoiceListControlsOutput,
  VoiceUiControl,
  VoiceUiControlRole,
  VoiceUiControlState,
} from "@t3tools/contracts";

import type { VoiceUiControlHost } from "../tools";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_CONTROLS_LIMIT = 60;
export const MAX_LIST_CONTROLS_LIMIT = 200;

const DOM_ROLE_TO_CONTROL_ROLE: Readonly<Record<string, VoiceUiControlRole>> = {
  button: "button",
  link: "link",
  menuitem: "menuitem",
  menuitemcheckbox: "menuitemcheckbox",
  menuitemradio: "menuitemradio",
  tab: "tab",
  switch: "switch",
  checkbox: "checkbox",
  radio: "radio",
  option: "option",
};

// ---------------------------------------------------------------------------
// Element abstraction (the seam the tests fake)
// ---------------------------------------------------------------------------

/** One candidate control as the pure core sees it. The adapter derives these
    from the live DOM; tests construct them directly. */
export interface VoiceControlCandidate<E extends object = object> {
  /** The underlying element. Identity and re-resolution key against this,
      never against the role or name. */
  readonly element: E;
  readonly role: VoiceUiControlRole;
  /** Accessible name at scan time; context only. */
  readonly name: string;
  readonly state: VoiceUiControlState;
  /** Performs the real activation. Never throws for a refused target: the
      resolution checks state before calling. */
  readonly activate: () => void;
}

// ---------------------------------------------------------------------------
// Opaque per-element identity registry
// ---------------------------------------------------------------------------

export interface VoiceControlIdRegistry<E extends object> {
  /** The stable id for one element: the same object always gets the same id
      for the registry's lifetime, so relistings do not churn ids and a click
      re-resolves to exactly the listed element. */
  idFor(element: E): string;
  /** The element a listed id was assigned to, or undefined once the element
      has been collected (a stale reference). */
  elementOf(controlId: string): E | undefined;
}

/** Opaque, monotonic ids (`ctl-1`, `ctl-2`, ...) backed by a WeakMap per
    element and a WeakRef per id. Nothing here can retarget: an id addresses
    one element or nothing. */
export function createControlIdRegistry<E extends object>(): VoiceControlIdRegistry<E> {
  let counter = 0;
  const idByElement = new WeakMap<E, string>();
  const elementById = new Map<string, WeakRef<E>>();
  return {
    idFor(element) {
      const existing = idByElement.get(element);
      if (existing !== undefined) {
        return existing;
      }
      counter += 1;
      const id = `ctl-${counter}`;
      idByElement.set(element, id);
      elementById.set(id, new WeakRef(element));
      return id;
    },
    elementOf(controlId) {
      const ref = elementById.get(controlId);
      const element = ref?.deref();
      if (element === undefined) {
        // Prune the dead entry so the map cannot grow without bound.
        elementById.delete(controlId);
        return undefined;
      }
      return element;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure core: listing
// ---------------------------------------------------------------------------

/** Lists controls in given order, applying the frozen input bounds. Ids come
    from the registry (stable per element); occurrence and ambiguity are
    computed across ALL attached candidates sharing role and name, regardless
    of the listing filters, so the reported context stays honest. */
export function listControlCandidates<E extends object>(
  candidates: ReadonlyArray<VoiceControlCandidate<E>>,
  input: VoiceListControlsInput,
  registry: VoiceControlIdRegistry<E>,
): VoiceListControlsOutput {
  const limit = Math.min(
    Math.max(input.limit ?? DEFAULT_LIST_CONTROLS_LIMIT, 0),
    MAX_LIST_CONTROLS_LIMIT,
  );
  const includeHidden = input.includeHidden === true;
  const query = input.query?.trim().toLowerCase() ?? "";

  const occurrences = new Map<VoiceControlCandidate<E>, number>();
  const countsByKey = new Map<string, number>();
  const seenByKey = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.role}\u0000${candidate.name}`;
    countsByKey.set(key, (countsByKey.get(key) ?? 0) + 1);
    const occurrence = (seenByKey.get(key) ?? 0) + 1;
    seenByKey.set(key, occurrence);
    occurrences.set(candidate, occurrence);
  }

  const filtered = candidates.filter(
    (candidate) =>
      (includeHidden || candidate.state !== "hidden") &&
      (query.length === 0 || candidate.name.toLowerCase().includes(query)),
  );
  const controls: VoiceUiControl[] = filtered.slice(0, limit).map((candidate) => {
    const key = `${candidate.role}\u0000${candidate.name}`;
    return {
      controlId: registry.idFor(candidate.element),
      role: candidate.role,
      name: candidate.name,
      state: candidate.state,
      occurrence: occurrences.get(candidate)!,
      ...(countsByKey.get(key)! > 1 ? { ambiguous: true } : {}),
    };
  });
  return {
    controls,
    ...(filtered.length > controls.length ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Pure core: resolution and activation
// ---------------------------------------------------------------------------

export type VoiceControlResolution =
  | {
      readonly state: "activated";
      readonly role: VoiceUiControlRole;
      readonly name: string;
    }
  | {
      readonly state: Exclude<VoiceClickControlOutput["state"], "activated">;
      readonly role?: VoiceUiControlRole;
      readonly name?: string;
      readonly message: string;
    };

const notFound = (message: string): VoiceControlResolution => ({ state: "not_found", message });

/** Re-resolves a listed id against the CURRENT candidates by element identity
    and activates it. An id whose element is collected or no longer matches a
    supported candidate is `not_found` (stale); a fabricated id is
    `unsupported`. The listed name and occurrence never participate in
    resolution, so a surviving same-named sibling can never be clicked by
    another control's id. */
export function resolveAndActivateControl<E extends object>(
  candidates: ReadonlyArray<VoiceControlCandidate<E>>,
  registry: VoiceControlIdRegistry<E>,
  input: VoiceClickControlInput,
): VoiceControlResolution {
  const controlId = input.controlId.trim();
  if (controlId.length === 0) {
    return notFound("Control id is empty; list controls first.");
  }
  const element = registry.elementOf(controlId);
  if (element === undefined) {
    return notFound(
      `"${controlId}" is not a control this session listed, or it is gone. Call listControls and use a current id.`,
    );
  }
  const target = candidates.find((candidate) => candidate.element === element);
  if (target === undefined) {
    return notFound(
      `"${controlId}" is stale: its control is no longer attached. Call listControls to refresh.`,
    );
  }
  if (target.state === "disabled") {
    return {
      state: "disabled",
      role: target.role,
      name: target.name,
      message: `The ${target.role} "${target.name}" is disabled and cannot be activated.`,
    };
  }
  if (target.state === "hidden") {
    return {
      state: "hidden",
      role: target.role,
      name: target.name,
      message: `The ${target.role} "${target.name}" is not visible; open its menu or dialog first.`,
    };
  }
  target.activate();
  return { state: "activated", role: target.role, name: target.name };
}

// ---------------------------------------------------------------------------
// DOM adapter
// ---------------------------------------------------------------------------

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

const SUBMIT_INPUT_DEFAULT_NAME = "Submit";
const RESET_INPUT_DEFAULT_NAME = "Reset";

function accessibleName(element: Element): string {
  const labelledby = element.getAttribute("aria-labelledby");
  if (labelledby !== null && labelledby.trim().length > 0) {
    const text = collapseWhitespace(
      labelledby
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    if (text.length > 0) {
      return text;
    }
  }
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel !== null && collapseWhitespace(ariaLabel).length > 0) {
    return collapseWhitespace(ariaLabel);
  }
  if (element instanceof element.ownerDocument.defaultView!.HTMLInputElement) {
    const type = element.getAttribute("type")?.toLowerCase();
    if (type === "submit") {
      return collapseWhitespace(element.value) || SUBMIT_INPUT_DEFAULT_NAME;
    }
    if (type === "reset") {
      return collapseWhitespace(element.value) || RESET_INPUT_DEFAULT_NAME;
    }
    if (type === "button") {
      return collapseWhitespace(element.value);
    }
  }
  const content = collapseWhitespace(element.textContent ?? "");
  if (content.length > 0) {
    return content;
  }
  const title = element.getAttribute("title");
  return collapseWhitespace(title ?? "");
}

function controlRoleOf(element: Element): VoiceUiControlRole | null {
  const explicit = element.getAttribute("role");
  if (explicit !== null) {
    return DOM_ROLE_TO_CONTROL_ROLE[explicit.toLowerCase()] ?? null;
  }
  const tag = element.tagName.toLowerCase();
  if (tag === "button" || tag === "summary") {
    return "button";
  }
  if (tag === "a" && element.hasAttribute("href")) {
    return "link";
  }
  if (tag === "option") {
    return "option";
  }
  if (tag === "input") {
    const type = element.getAttribute("type")?.toLowerCase() ?? "text";
    if (type === "button" || type === "submit" || type === "reset") {
      return "button";
    }
    if (type === "checkbox") {
      return "checkbox";
    }
    if (type === "radio") {
      return "radio";
    }
  }
  return null;
}

function controlStateOf(element: Element): VoiceUiControlState {
  if (element.getAttribute("aria-hidden") === "true" || element.getClientRects().length === 0) {
    return "hidden";
  }
  if (element.getAttribute("aria-disabled") === "true") {
    return "disabled";
  }
  const ownerWindow = element.ownerDocument.defaultView;
  if (
    ownerWindow !== null &&
    element instanceof ownerWindow.HTMLButtonElement &&
    element.disabled
  ) {
    return "disabled";
  }
  if (ownerWindow !== null && element instanceof ownerWindow.HTMLInputElement && element.disabled) {
    return "disabled";
  }
  return "enabled";
}

const CANDIDATE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  "option",
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="option"]',
].join(", ");

function elementCenter(element: Element): { clientX: number; clientY: number } {
  const rect = element.getBoundingClientRect();
  return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
}

function dispatchPointerSequence(element: HTMLElement, role: VoiceUiControlRole): void {
  const ownerWindow = element.ownerDocument.defaultView;
  if (ownerWindow === null) {
    return;
  }
  const point = elementCenter(element);
  const mouseInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ...point,
  };
  if (typeof ownerWindow.PointerEvent === "function") {
    element.dispatchEvent(
      new ownerWindow.PointerEvent("pointerdown", { ...mouseInit, pointerId: 1, isPrimary: true }),
    );
    element.dispatchEvent(new ownerWindow.MouseEvent("mousedown", mouseInit));
    element.dispatchEvent(
      new ownerWindow.PointerEvent("pointerup", { ...mouseInit, pointerId: 1, isPrimary: true }),
    );
    element.dispatchEvent(new ownerWindow.MouseEvent("mouseup", mouseInit));
  } else {
    element.dispatchEvent(new ownerWindow.MouseEvent("mousedown", mouseInit));
    element.dispatchEvent(new ownerWindow.MouseEvent("mouseup", mouseInit));
  }
  // HTMLElement.click() dispatches the click event AND runs native default
  // actions (checkbox toggle, radio selection, link navigation), which
  // dispatched-only events never do.
  if (role === "option" && element instanceof ownerWindow.HTMLOptionElement) {
    element.selected = true;
    element.dispatchEvent(new ownerWindow.Event("input", { bubbles: true }));
    element.dispatchEvent(new ownerWindow.Event("change", { bubbles: true }));
    return;
  }
  element.click();
}

function candidateFromElement(element: Element): VoiceControlCandidate<Element> | null {
  const role = controlRoleOf(element);
  if (role === null) {
    return null;
  }
  return {
    element,
    role,
    name: accessibleName(element),
    state: controlStateOf(element),
    activate: () => {
      if (element instanceof element.ownerDocument.defaultView!.HTMLElement) {
        dispatchPointerSequence(element, role);
      }
    },
  };
}

function currentCandidates(): VoiceControlCandidate<Element>[] {
  if (typeof document === "undefined") {
    return [];
  }
  return [...document.querySelectorAll(CANDIDATE_SELECTOR)]
    .map(candidateFromElement)
    .filter((candidate): candidate is VoiceControlCandidate<Element> => candidate !== null);
}

/** The DOM-backed control host for this attached web client. The id registry
    lives for the host's lifetime so ids are stable across listings; every
    scan and activation happens lazily per call against the live document. */
export function createDomVoiceControlHost(): VoiceUiControlHost {
  const registry = createControlIdRegistry<Element>();
  return {
    listControls: async (input) => listControlCandidates(currentCandidates(), input, registry),
    clickControl: async (input) => {
      const resolution = resolveAndActivateControl(currentCandidates(), registry, input);
      return { controlId: input.controlId, ...resolution };
    },
  };
}
