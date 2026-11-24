import { expect, it } from "vite-plus/test";

import { sidewaysWheelDelta } from "./gesture";

it.each([
  { deltaX: 0, deltaY: 40, shiftKey: true, expected: 40 },
  { deltaX: 0, deltaY: -40, shiftKey: true, expected: -40 },
  { deltaX: 40, deltaY: 0, shiftKey: true, expected: 40 },
  { deltaX: 0, deltaY: 40, shiftKey: false, expected: 0 },
  { deltaX: 3, deltaY: 40, shiftKey: false, expected: 0 },
  { deltaX: 40, deltaY: 3, shiftKey: false, expected: 40 },
  { deltaX: 0, deltaY: 40, shiftKey: true, ctrlKey: true, expected: 0 },
  { deltaX: 0, deltaY: 40, shiftKey: true, metaKey: true, expected: 0 },
  { deltaX: 0, deltaY: 40, shiftKey: true, altKey: true, expected: 0 },
])(
  "normalizes sideways wheel travel: $deltaX/$deltaY, shift $shiftKey",
  ({ expected, ...event }) => {
    expect(sidewaysWheelDelta({ ctrlKey: false, metaKey: false, altKey: false, ...event })).toBe(
      expected,
    );
  },
);
