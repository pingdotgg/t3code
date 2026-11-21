import { describe, expect, it } from "vite-plus/test";

import type { DeviceAxElement } from "./deviceHubApi";
import {
  buildDeviceRecording,
  type DeviceInput,
  type DeviceRecordingCapture,
  formatDeviceRecordingPrompt,
  hitTestDeviceElements,
  limitRecordingFrames,
  mergeDeviceInputs,
  pickKeyframes,
  type TimedDeviceInput,
} from "./deviceRecording.logic";

const touch = (phase: "begin" | "move" | "end", x: number, y: number) =>
  ({ type: "touch", phase, x, y }) as const;
const key = (value: string, modifiers: { meta?: boolean } = {}) =>
  ({ type: "key", key: value, ...modifiers }) as const;
const timed = (...entries: ReadonlyArray<readonly [number, DeviceInput]>): TimedDeviceInput[] =>
  entries.map(([at, input]) => ({ at, input }));

const element = (
  label: string,
  role: string,
  box: readonly [number, number, number, number],
): DeviceAxElement => ({
  id: `${role}:${label}`,
  label,
  role,
  x: box[0],
  y: box[1],
  width: box[2],
  height: box[3],
});

describe("mergeDeviceInputs", () => {
  it.each([
    [
      "a quick touch in place",
      timed([0, touch("begin", 0.5, 0.5)], [80, touch("end", 0.51, 0.5)]),
      { kind: "tap", point: { x: 0.5, y: 0.5 } },
    ],
    [
      "a held touch",
      timed([0, touch("begin", 0.5, 0.5)], [700, touch("end", 0.5, 0.5)]),
      { kind: "longPress", point: { x: 0.5, y: 0.5 } },
    ],
    [
      "a fast upward flick",
      timed(
        [0, touch("begin", 0.5, 0.8)],
        [60, touch("move", 0.5, 0.6)],
        [150, touch("end", 0.5, 0.3)],
      ),
      { kind: "swipe", direction: "up", from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.3 } },
    ],
    [
      "a slow move",
      timed(
        [0, touch("begin", 0.2, 0.5)],
        [900, touch("move", 0.3, 0.5)],
        [1_800, touch("end", 0.4, 0.5)],
      ),
      { kind: "drag", from: { x: 0.2, y: 0.5 }, to: { x: 0.4, y: 0.5 } },
    ],
  ] as const)("reads %s as one gesture", (_name, inputs, action) => {
    expect(mergeDeviceInputs(inputs)).toEqual([{ startAt: 0, action }]);
  });

  it("merges keystrokes and pastes into typed text, and repeats of a key into one step", () => {
    const steps = mergeDeviceInputs(
      timed(
        [0, key("Shift")],
        [10, key("H")],
        [20, key("i")],
        [30, { type: "text", text: " there!" }],
        [40, key("Backspace")],
        [50, key("Enter")],
        [60, key("Enter")],
        [70, key("x")],
        [80, key("Backspace")],
        [90, key("Backspace")],
        [100, key("r", { meta: true })],
      ),
    );
    expect(steps.map((step) => step.action)).toEqual([
      { kind: "typed", text: "Hi there" },
      { kind: "key", key: "Enter", count: 2 },
      { kind: "key", key: "Backspace", count: 1 },
      { kind: "key", key: "Cmd+R", count: 1 },
    ]);
  });
});

describe("hitTestDeviceElements", () => {
  // Tree order is paint order: a row's text follows the row, and a floating field follows the list.
  const elements = [
    element("Settings", "Button", [0, 0.2, 1, 0.1]),
    element("General", "StaticText", [0.1, 0.22, 0.3, 0.05]),
    element("StandBy", "Button", [0, 0.9, 1, 0.08]),
    element("", "TextField", [0.05, 0.92, 0.9, 0.04]),
  ];

  it.each([
    ["the topmost element under the point", { x: 0.2, y: 0.24 }, "General", null],
    ["the containing element away from its children", { x: 0.9, y: 0.25 }, "Settings", null],
    [
      "an unlabeled element on top, with the labeled one beneath",
      { x: 0.5, y: 0.94 },
      "",
      "StandBy",
    ],
  ])("picks %s", (_name, point, label, beneath) => {
    const target = hitTestDeviceElements(elements, point);
    expect([target?.element.label, target?.beneath?.label ?? null]).toEqual([label, beneath]);
  });

  it("finds nothing outside every element", () => {
    expect(hitTestDeviceElements(elements, { x: 0.5, y: 0.6 })).toBeNull();
  });
});

describe("buildDeviceRecording", () => {
  const screen = [
    element("Settings", "Button", [0.4, 0.4, 0.2, 0.1]),
    element("StandBy", "Button", [0, 0.9, 1, 0.08]),
    element("", "TextField", [0.05, 0.92, 0.9, 0.04]),
  ];
  const capture = (
    requestedAt: number,
    elements: ReadonlyArray<DeviceAxElement> | null = screen,
  ): DeviceRecordingCapture => ({ requestedAt, hasFrame: true, elements });

  it("names each tap from the tree captured before it and points at the frame that followed", () => {
    const recording = buildDeviceRecording(
      timed(
        [1_000, touch("begin", 0.5, 0.45)],
        [1_080, touch("end", 0.5, 0.45)],
        [3_000, touch("begin", 0.5, 0.94)],
        [3_080, touch("end", 0.5, 0.94)],
      ),
      [capture(0), capture(1_600), capture(3_600)],
    );
    expect(
      formatDeviceRecordingPrompt({
        header: "Recorded on Phone, 0:02.",
        recording,
        frameReference: (frame) => `[frame ${frame + 1}]`,
        notes: ["No video."],
      }),
    ).toBe(
      [
        "Recorded on Phone, 0:02.",
        "",
        "Start: [frame 1]",
        '1. Tapped button "Settings" → [frame 2]',
        '2. Tapped text field at (50%, 94%), over button "StandBy" → [frame 3]',
        "",
        "No video.",
      ].join("\n"),
    );
  });

  it("falls back to coordinates when the latest tree predates the previous step", () => {
    const recording = buildDeviceRecording(
      timed(
        [100, touch("begin", 0.5, 0.45)],
        [150, touch("end", 0.5, 0.45)],
        [300, touch("begin", 0.5, 0.45)],
        [350, touch("end", 0.5, 0.45)],
      ),
      [capture(0), capture(900)],
    );
    expect(recording.steps.map((step) => step.target?.element.label ?? null)).toEqual([
      "Settings",
      null,
    ]);
  });

  it("falls back to coordinates when the tree could not be read", () => {
    const recording = buildDeviceRecording(
      timed([100, touch("begin", 0.5, 0.45)], [150, touch("end", 0.5, 0.45)]),
      [capture(0, null)],
    );
    expect(recording.steps[0]?.target).toBeNull();
  });

  it("keeps only the last frame of a step that outlives several captures", () => {
    const recording = buildDeviceRecording(
      timed([100, key("a")], [1_000, key("b")], [2_000, key("c")]),
      [capture(0), capture(700), capture(1_600), capture(2_600)],
    );
    expect(recording).toMatchObject({
      initialFrame: 0,
      steps: [{ action: { kind: "typed", text: "abc" }, frame: 3 }],
    });
  });
});

describe("frame limits", () => {
  it("keeps the first and last frames and spreads the rest", () => {
    expect([...pickKeyframes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)].toSorted((a, b) => a - b)).toEqual(
      [0, 3, 6, 9],
    );
    expect(pickKeyframes([4, 5], 12)).toEqual(new Set([4, 5]));
  });

  it("drops the frames it does not keep from their steps", () => {
    const recording = limitRecordingFrames(
      {
        initialFrame: 0,
        steps: [1, 2, 3].map((frame) => ({
          startAt: frame,
          action: { kind: "rotate" },
          target: null,
          frame,
        })),
      },
      2,
    );
    expect([recording.initialFrame, ...recording.steps.map((step) => step.frame)]).toEqual([
      0,
      null,
      null,
      3,
    ]);
  });
});
