import { assert, describe, it } from "@effect/vitest";

import { busyBarIntroFrames } from "./BusyBarMotion.ts";

const card = { label: "QUESTION", color: "#2979FFFF", title: "Fix it", timeoutSeconds: 0 };

describe("busyBarIntroFrames", () => {
  it("only updates elements the first frame mounted", () => {
    // An element first drawn mid-sequence flashes above higher layers for a frame.
    const [mount, ...rest] = busyBarIntroFrames(card);
    const mounted = new Set(mount!.elements.map((element) => element.id));
    for (const frame of rest) {
      for (const element of frame.elements) assert.isTrue(mounted.has(element.id), element.id);
    }
  });

  it("keeps every frame on the display", () => {
    for (const label of ["DONE", "FAILED", "APPROVE", "QUESTION"]) {
      for (const frame of busyBarIntroFrames({ ...card, label })) {
        for (const element of frame.elements) {
          const x = element.x as number;
          if (element.id === "title") continue; // Slides in from off the right edge.
          assert.isAtLeast(x, 0, `${label} ${element.id}`);
          assert.isAtMost(
            x + ((element.width as number | undefined) ?? 0),
            72,
            `${label} ${element.id}`,
          );
        }
      }
    }
  });
});
