// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/computer/types.ts), modified for Ada.
// LocalRouter ported it from Sidebud (github.com/jayleaton/sidebud @70da540); both notices ship in LICENSE.localrouter.

/**
 * Computer use: the helper moves the real cursor and presses real keys on this Mac (a browser tab, an
 * app window) toward a goal, one small step at a time, with the server choosing each step from the
 * controls the screen actually has and granting each action before it happens.
 */

/** A point in global screen coordinates (top-left origin). Every Point and Rect a backend reports or takes is in this space. */
export type Point = { x: number; y: number };

/** A rectangle in the same global space as Point. */
export type Rect = { x: number; y: number; w: number; h: number };

/** The pointer as the local stop reads it: where it is, and how long ago the left button last went down, if known. */
export type PointerReading = Point & { sinceClickS?: number };

/** One control on screen that can be acted on. */
export type ScreenControl = {
  /** The backend's handle for it, valid until the next observation. */
  ref: string;
  /** `text` is a line of text read from a screenshot, when the app would not show its window through accessibility. */
  role:
    | "button"
    | "link"
    | "textbox"
    | "tab"
    | "row"
    | "menuitem"
    | "checkbox"
    | "option"
    | "text"
    | "other";
  /** Its visible text or accessible name, clipped. */
  label: string;
  /** A text box's current text, clipped. */
  value?: string;
  focused?: boolean;
  /** Where it is on screen, when the backend knows (for a caller that reads the tree next to a screenshot). */
  bounds?: Rect;
};

export const CONTROL_ROLES = [
  "button",
  "link",
  "textbox",
  "tab",
  "row",
  "menuitem",
  "checkbox",
  "option",
  "text",
  "other",
] as const;

/** What is on screen now, for one decision. */
export type Observation = {
  backend: "browser" | "desktop";
  app: string;
  /** The window or tab title. */
  title: string;
  url?: string;
  /** Visible, actionable controls, in reading order (at most about 150). */
  controls: ScreenControl[];
  /** A short excerpt of the visible text, for context (at most about 1,500 characters). */
  text?: string;
  /** Read from a screenshot: only text is listed, not icons such as a play button. */
  visual?: boolean;
  /** The window observed, in global coordinates, when the backend knows. */
  window?: Rect;
  /** The walk stopped early (its node, control or time budget ran out): more may be on screen than is listed. */
  truncated?: boolean;
};

export type ScreenAction =
  | { kind: "click"; ref: string }
  /** Focus the control and replace its text with `text`. */
  | { kind: "type"; ref: string; text: string }
  | { kind: "press"; key: "enter" | "escape" | "tab" | "space" }
  /** `ref`: the list or area to scroll (a control of this observation); the window's middle when absent. */
  | { kind: "scroll"; direction: "up" | "down" | "top" | "bottom"; ref?: string };

/**
 * How an action reached the app. `background`: without the person's real pointer, focus or keyboard (an accessibility
 * action, a value set through accessibility, input posted to the app's own window or process). `pointer`: the real
 * pointer and global keyboard, only after the person allowed it for that step.
 */
export type InputMode = "background" | "pointer";

/** What an action did: how it reached the app, and where it acted, for the audit. */
export type ActResult = {
  mode: InputMode;
  pointer?: Point;
  at?: Point;
  how?: string;
};

export type ObserveOptions = { signal?: AbortSignal };

/**
 * `signal` aborts an action under way (a stop): long typing stops between chunks, a running script is killed.
 * `allowPointer`: the person allowed the real pointer and keyboard for this one step. Without it a backend acts in the
 * background or throws NeedsPointer, and never touches the real pointer or global keyboard.
 */
export type ActOptions = { signal?: AbortSignal; allowPointer?: boolean };

/**
 * Thrown by a backend when an action cannot be done in the background (a canvas or game with no accessible control, an
 * app that ignores input posted to its window). The controller then asks the server to ask the person for their mouse.
 */
export class NeedsPointer extends Error {
  readonly why: string;

  constructor(why: string) {
    super(`This step needs your mouse for a moment: ${why}`);
    this.name = "NeedsPointer";
    this.why = why;
  }
}

/** Whether an error is NeedsPointer, across module copies (the bundle and the tests). */
export function needsPointer(error: unknown): error is NeedsPointer {
  return (
    error instanceof NeedsPointer ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "NeedsPointer")
  );
}

/** Reads and drives one surface. Errors are thrown with a message a person can act on. */
export interface ScreenBackend {
  readonly kind: "browser" | "desktop";
  observe(options?: ObserveOptions): Promise<Observation>;
  /** Resolves with where the pointer was left when the action moved it (clicks, typing, scrolling). */
  act(action: ScreenAction, options?: ActOptions): Promise<ActResult | void>;
  /** Where the pointer is now, for the local stop. */
  pointer?(): Promise<PointerReading>;
  /** Every display's bounds, in global coordinates (the local stop's corners are worked out from them). */
  displays?(): Promise<Rect[]>;
}

/** One open browser tab. */
export type BrowserTab = {
  window: number;
  index: number;
  title: string;
  url: string;
  active: boolean;
};

/** A named tab group and its tabs' titles as the tab strip shows them, in order. */
export type TabGroup = { name: string; tabs: string[] };

/**
 * macOS Automation (Apple Events to another app) checked without asking: true only when macOS already gave this app
 * its OK to control the target (by bundle id). Nothing that would show "Ada wants to control …" runs during a task
 * unless this said yes. Absent: Apple Events are sent as before.
 */
export interface AutomationCheck {
  allowed(bundleId: string): Promise<boolean>;
}

/** The browser's open tabs (read-only), and switching to one by clicking it in the tab strip with the cursor. */
export interface BrowserTabs {
  readonly browser: string;
  list(): Promise<BrowserTab[]>;
  /** Named tab groups, read from the tab strip (tab lists from the browser do not say which group a tab is in). */
  groups?(): Promise<TabGroup[]>;
  /** Brings the browser forward and clicks the tab in its tab strip. */
  activate(tab: BrowserTab): Promise<void>;
  /** For when the browser's tabs cannot be read: switches with the browser's own tab search, or null when nothing matched. */
  search?(name: string): Promise<string | null>;
}

/**
 * The local stop as the controller sees it: checked before each action, told when the helper is about
 * to move the pointer itself and where it left it, so only a person's movement stops the task.
 */
export interface PointerWatch {
  /** Checks the pointer now; aborts the running task when the person took over. */
  check(): Promise<void>;
  /** The helper is about to move the pointer, or is waiting for the server: movement is not a takeover until `left`. */
  moving(): void;
  /** Where the helper left the pointer: a point, undefined when it did not move it, null when it moved somewhere unknown. */
  left(point?: Point | null): void;
  /** The helper did not use the real pointer after all: the pointer is the person's again at once. */
  released?(): void;
}
