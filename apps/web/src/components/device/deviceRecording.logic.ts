import type { DeviceHardwareButton, DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import type { DeviceActionInput } from "@t3tools/contracts";

import type { DeviceAxElement } from "./deviceHubApi";

/** Input the panel sent to a device, as the recorder sees it. Touch points are 0..1 of the screen. */
export type DeviceInput =
  | {
      readonly type: "touch";
      readonly phase: "begin" | "move" | "end";
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "key";
      readonly key: string;
      readonly ctrl?: boolean;
      readonly alt?: boolean;
      readonly meta?: boolean;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "button"; readonly button: DeviceHardwareButton }
  | { readonly type: "rotate" }
  | { readonly type: "orientation"; readonly orientation: DeviceScreenSize["orientation"] }
  /** A host-side change such as appearance, already phrased as a step. */
  | { readonly type: "action"; readonly description: string };

/** A host action as the Device panel sends it, before the device target is added. */
export type DeviceActionBody = DeviceActionInput extends infer A
  ? A extends { readonly type: string }
    ? Omit<A, "hostId" | "deviceId">
    : never
  : never;

export interface TimedDeviceInput {
  /** Milliseconds since the recording started. */
  readonly at: number;
  readonly input: DeviceInput;
}

export interface DeviceRecordingCapture {
  /** When the screenshot and tree were requested, so they show the screen at that moment. */
  readonly requestedAt: number;
  readonly hasFrame: boolean;
  readonly elements: ReadonlyArray<DeviceAxElement> | null;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

export type DeviceStepAction =
  | { readonly kind: "tap" | "longPress"; readonly point: Point }
  | {
      readonly kind: "swipe";
      readonly direction: "up" | "down" | "left" | "right";
      readonly from: Point;
      readonly to: Point;
    }
  | { readonly kind: "drag"; readonly from: Point; readonly to: Point }
  | { readonly kind: "typed"; readonly text: string }
  | { readonly kind: "key"; readonly key: string; readonly count: number }
  | { readonly kind: "button"; readonly button: DeviceHardwareButton }
  | { readonly kind: "rotate" }
  | { readonly kind: "orientation"; readonly orientation: DeviceScreenSize["orientation"] }
  | { readonly kind: "action"; readonly description: string };

export interface DeviceStep {
  readonly startAt: number;
  readonly action: DeviceStepAction;
}

// Normalized screen distance a finger may wander and still count as a tap.
const TAP_SLOP = 0.03;
const LONG_PRESS_MS = 500;
// Screens per millisecond: a flick crosses a whole screen in about a second.
const SWIPE_MIN_SPEED = 0.001;
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Fn",
  "OS",
  "Dead",
  "Unidentified",
]);

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function classifyTouch(points: ReadonlyArray<Point & { readonly at: number }>): DeviceStepAction {
  const first = points[0]!;
  const last = points.at(-1)!;
  const wander = Math.max(...points.map((point) => distance(point, first)));
  const duration = last.at - first.at;
  const from = { x: first.x, y: first.y };
  if (wander <= TAP_SLOP) {
    return { kind: duration >= LONG_PRESS_MS ? "longPress" : "tap", point: from };
  }
  const to = { x: last.x, y: last.y };
  const travelled = distance(from, to);
  if (travelled / Math.max(duration, 1) < SWIPE_MIN_SPEED) return { kind: "drag", from, to };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const direction =
    Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  return { kind: "swipe", direction, from, to };
}

function chordName(input: Extract<DeviceInput, { type: "key" }>): string {
  const key = input.key.length === 1 ? input.key.toUpperCase() : input.key;
  return [input.ctrl && "Ctrl", input.alt && "Alt", input.meta && "Cmd", key]
    .filter(Boolean)
    .join("+");
}

/** Folds raw input into steps: touches into gestures, keystrokes and pastes into typed text. */
export function mergeDeviceInputs(inputs: ReadonlyArray<TimedDeviceInput>): DeviceStep[] {
  const steps: DeviceStep[] = [];
  let touch: Array<Point & { readonly at: number }> | null = null;
  const last = () => steps.at(-1);
  const replaceLast = (action: DeviceStepAction) => {
    steps[steps.length - 1] = { ...steps.at(-1)!, action };
  };
  const appendTyped = (at: number, text: string) => {
    const previous = last();
    if (previous?.action.kind === "typed")
      replaceLast({ kind: "typed", text: previous.action.text + text });
    else steps.push({ startAt: at, action: { kind: "typed", text } });
  };
  for (const { at, input } of inputs) {
    switch (input.type) {
      case "touch":
        if (input.phase === "begin") touch = [{ x: input.x, y: input.y, at }];
        else if (touch) {
          touch.push({ x: input.x, y: input.y, at });
          if (input.phase === "end") {
            steps.push({ startAt: touch[0]!.at, action: classifyTouch(touch) });
            touch = null;
          }
        }
        break;
      case "text":
        if (input.text.length > 0) appendTyped(at, input.text);
        break;
      case "key": {
        if (MODIFIER_KEYS.has(input.key)) break;
        const chord = input.ctrl || input.meta;
        if (!chord && input.key.length === 1) {
          appendTyped(at, input.key);
          break;
        }
        const previous = last();
        if (!chord && input.key === "Backspace" && previous?.action.kind === "typed") {
          const text = [...previous.action.text].slice(0, -1).join("");
          if (text.length > 0) replaceLast({ kind: "typed", text });
          else steps.pop();
          break;
        }
        const key = chordName(input);
        if (previous?.action.kind === "key" && previous.action.key === key) {
          replaceLast({ kind: "key", key, count: previous.action.count + 1 });
        } else steps.push({ startAt: at, action: { kind: "key", key, count: 1 } });
        break;
      }
      case "button":
        steps.push({ startAt: at, action: { kind: "button", button: input.button } });
        break;
      case "rotate":
        steps.push({ startAt: at, action: { kind: "rotate" } });
        break;
      case "orientation":
        steps.push({
          startAt: at,
          action: { kind: "orientation", orientation: input.orientation },
        });
        break;
      case "action":
        steps.push({ startAt: at, action: { kind: "action", description: input.description } });
        break;
    }
  }
  return steps;
}

export interface DeviceTouchTarget {
  /** The topmost element under the point: the last one in tree order. */
  readonly element: DeviceAxElement;
  /** When that element has no label, the topmost labeled element under the point. */
  readonly beneath: DeviceAxElement | null;
}

export function hitTestDeviceElements(
  elements: ReadonlyArray<DeviceAxElement>,
  point: Point,
): DeviceTouchTarget | null {
  const hits = elements.filter(
    (element) =>
      point.x >= element.x &&
      point.x <= element.x + element.width &&
      point.y >= element.y &&
      point.y <= element.y + element.height,
  );
  const element = hits.at(-1);
  if (!element) return null;
  return {
    element,
    beneath: element.label ? null : (hits.findLast((hit) => hit.label !== "") ?? null),
  };
}

export interface DeviceRecordingStep extends DeviceStep {
  readonly target: DeviceTouchTarget | null;
  /** Index into the captures, or null when this step has no frame of its own. */
  readonly frame: number | null;
}

export interface DeviceRecording {
  readonly initialFrame: number | null;
  readonly steps: ReadonlyArray<DeviceRecordingStep>;
}

const touchOrigin = (action: DeviceStepAction): Point | null =>
  action.kind === "tap" || action.kind === "longPress"
    ? action.point
    : action.kind === "swipe" || action.kind === "drag"
      ? action.from
      : null;

/**
 * Pairs steps with the captures around them. A touch is hit-tested only against a tree
 * captured after the previous step, since anything older may show a different screen.
 * Each capture belongs to the last step started before it; when a step outlives several
 * captures, as long typing does, it keeps only the latest one.
 */
export function buildDeviceRecording(
  inputs: ReadonlyArray<TimedDeviceInput>,
  captures: ReadonlyArray<DeviceRecordingCapture>,
): DeviceRecording {
  const steps = mergeDeviceInputs(inputs);
  const frames = new Map<number, number>();
  let initialFrame: number | null = null;
  captures.forEach((capture, index) => {
    if (!capture.hasFrame) return;
    let owner = -1;
    for (let step = 0; step < steps.length; step++) {
      if (steps[step]!.startAt <= capture.requestedAt) owner = step;
    }
    if (owner < 0) initialFrame ??= index;
    else frames.set(owner, index);
  });
  return {
    initialFrame,
    steps: steps.map((step, index) => {
      const origin = touchOrigin(step.action);
      const previousStart = index > 0 ? steps[index - 1]!.startAt : Number.NEGATIVE_INFINITY;
      const tree = origin
        ? captures.findLast(
            (capture) =>
              capture.elements !== null &&
              capture.requestedAt <= step.startAt &&
              capture.requestedAt >= previousStart,
          )?.elements
        : undefined;
      return {
        ...step,
        target: origin && tree ? hitTestDeviceElements(tree, origin) : null,
        frame: frames.get(index) ?? null,
      };
    }),
  };
}

/** Keeps the first and last frames and spreads the rest evenly between them. */
export function pickKeyframes(frames: ReadonlyArray<number>, cap: number): ReadonlySet<number> {
  if (frames.length <= cap) return new Set(frames);
  if (cap <= 1) return new Set(frames.slice(-1));
  const kept = new Set<number>();
  for (let slot = 0; slot < cap; slot++) {
    kept.add(frames[Math.round((slot * (frames.length - 1)) / (cap - 1))]!);
  }
  return kept;
}

/** Drops all but `cap` frames, keeping the start and end of the recording. */
export function limitRecordingFrames(recording: DeviceRecording, cap: number): DeviceRecording {
  const frames = [
    ...(recording.initialFrame === null ? [] : [recording.initialFrame]),
    ...recording.steps.flatMap((step) => (step.frame === null ? [] : [step.frame])),
  ];
  const kept = pickKeyframes(frames, cap);
  const keep = (frame: number | null) => (frame !== null && kept.has(frame) ? frame : null);
  return {
    initialFrame: keep(recording.initialFrame),
    steps: recording.steps.map((step) => ({ ...step, frame: keep(step.frame) })),
  };
}

const percent = (value: number) => `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
const formatPoint = (point: Point) => `(${percent(point.x)}, ${percent(point.y)})`;

const ROLE_ALIASES: Readonly<Record<string, string>> = {
  "static text": "text",
  "text view": "text",
  "edit text": "text field",
  "image view": "image",
};

function roleName(element: DeviceAxElement): string {
  const words = element.role
    .replace(/^(XCUIElementType|AX)/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return ROLE_ALIASES[words] ?? words;
}

const describeLabeled = (element: DeviceAxElement) => {
  const role = roleName(element);
  return `${role ? `${role} ` : ""}${JSON.stringify(element.label.replace(/\s+/g, " ").trim())}`;
};

/** Names what a touch landed on; an unlabeled element keeps its point and what lies beneath it. */
function describeTouch(target: DeviceTouchTarget | null, point: Point): string {
  if (!target) return `at ${formatPoint(point)}`;
  const { element, beneath } = target;
  if (element.label) return describeLabeled(element);
  return `${roleName(element) || "element"} at ${formatPoint(point)}${
    beneath ? `, over ${describeLabeled(beneath)}` : ""
  }`;
}

/** The labeled element a gesture started on, for swipes and drags that already give points. */
const gestureOrigin = (target: DeviceTouchTarget | null) => {
  const labeled = target?.element.label ? target.element : target?.beneath;
  return labeled ? describeLabeled(labeled) : null;
};

const BUTTON_STEPS: Readonly<Record<DeviceHardwareButton, string>> = {
  home: "Pressed Home",
  back: "Pressed Back",
  recents: "Opened recent apps",
  appSwitcher: "Opened the app switcher",
  power: "Pressed the power button",
};

/* oxlint-disable t3code/no-untranslated-copy -- recorded steps are written into the prompt for the agent, which stays English */
function describeDeviceStep(step: Pick<DeviceRecordingStep, "action" | "target">): string {
  const { action, target } = step;
  switch (action.kind) {
    case "tap":
      return `Tapped ${describeTouch(target, action.point)}`;
    case "longPress":
      return `Long-pressed ${describeTouch(target, action.point)}`;
    case "swipe": {
      const origin = gestureOrigin(target);
      return `Swiped ${action.direction}${origin ? ` on ${origin}` : ""} from ${formatPoint(action.from)} to ${formatPoint(action.to)}`;
    }
    case "drag": {
      const origin = gestureOrigin(target);
      return `Dragged${origin ? ` ${origin}` : ""} from ${formatPoint(action.from)} to ${formatPoint(action.to)}`;
    }
    case "typed":
      return `Typed ${JSON.stringify(action.text)}`;
    case "key":
      return `Pressed ${action.key}${action.count > 1 ? ` ×${action.count}` : ""}`;
    case "button":
      return BUTTON_STEPS[action.button];
    case "rotate":
      return "Rotated the device";
    case "orientation":
      return `Set orientation to ${action.orientation.replaceAll("_", " ")}`;
    case "action":
      return action.description;
  }
}
/* oxlint-enable t3code/no-untranslated-copy */

export function formatRecordingDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The draft text: a header, the numbered steps, and an inline reference to each step's
 * frame so the agent can match what happened to what the screen showed.
 */
export function formatDeviceRecordingPrompt(input: {
  readonly header: string;
  readonly recording: DeviceRecording;
  /** Inline reference for an attached frame, or null when the frame could not attach. */
  readonly frameReference: (frame: number) => string | null;
  readonly notes: ReadonlyArray<string>;
}): string {
  const lines = [input.header, ""];
  const initial =
    input.recording.initialFrame === null
      ? null
      : input.frameReference(input.recording.initialFrame);
  if (initial) lines.push(`Start: ${initial}`);
  if (input.recording.steps.length === 0) lines.push("No input was recorded.");
  input.recording.steps.forEach((step, index) => {
    const frame = step.frame === null ? null : input.frameReference(step.frame);
    lines.push(`${index + 1}. ${describeDeviceStep(step)}${frame ? ` → ${frame}` : ""}`);
  });
  if (input.notes.length > 0) lines.push("", ...input.notes);
  return lines.join("\n");
}

/** Phrases a Device panel host action as a recorded step. */
/* oxlint-disable t3code/no-untranslated-copy -- recorded steps are written into the prompt for the agent, which stays English */
export function describeDeviceAction(action: DeviceActionBody): string {
  switch (action.type) {
    case "setAppearance":
      return `Switched the device to ${action.value} mode`;
    case "setTextSize":
      return `Set text size to ${action.value.replace("-", " ")}`;
    case "setOrientation":
      return `Set orientation to ${action.value.replaceAll("_", " ")}`;
    case "setToggle":
      return `Turned ${action.value ? "on" : "off"} ${action.setting}`;
    case "setLiquidGlass":
      return `Set Liquid Glass to ${action.value}`;
    case "setColorFilter":
      return `Set color filter to ${action.value}`;
    case "setLocation":
      return `Set location to ${action.latitude}, ${action.longitude}`;
    case "clearLocation":
      return "Cleared the simulated location";
    case "setPermission":
      return action.decision === "grant"
        ? `Granted ${action.permission} permission to ${action.appId}`
        : action.decision === "revoke"
          ? `Revoked ${action.permission} permission from ${action.appId}`
          : `Reset ${action.permission} permission for ${action.appId}`;
    case "openUrl":
      return `Opened ${action.url}`;
    case "launchApp":
      return `Launched ${action.appId}`;
    case "terminateApp":
      return `Quit ${action.appId}`;
    case "shake":
      return "Shook the device";
    case "sendPush":
      return `Sent a push notification to ${action.appId}`;
  }
}
/* oxlint-enable t3code/no-untranslated-copy */
