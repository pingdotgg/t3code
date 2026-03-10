import { describe, expect, it } from "vitest";

import {
  animateSidebarReorder,
  buildSidebarReorderDeltas,
  collectElementTopPositions,
  hasSidebarReorderChanged,
  SIDEBAR_REORDER_TRANSITION,
} from "./sidebarReorderAnimation";

function makeElement(top: number) {
  return {
    style: {
      transition: "",
      transform: "",
      willChange: "",
    },
    getBoundingClientRect: () => ({ top }),
  };
}

describe("sidebarReorderAnimation", () => {
  it("detects when the visible order changes", () => {
    expect(
      hasSidebarReorderChanged(["project-a", "project-b"], ["project-a", "project-b"]),
    ).toBe(false);
    expect(
      hasSidebarReorderChanged(["project-a", "project-b"], ["project-b", "project-a"]),
    ).toBe(true);
    expect(hasSidebarReorderChanged(["project-a"], ["project-a", "project-b"])).toBe(true);
  });

  it("builds vertical animation deltas from previous and next row positions", () => {
    expect(
      buildSidebarReorderDeltas(
        new Map([
          ["project-a", 20],
          ["project-b", 60],
        ]),
        new Map([
          ["project-a", 60],
          ["project-b", 20],
        ]),
      ),
    ).toEqual([
      { id: "project-a", deltaY: -40 },
      { id: "project-b", deltaY: 40 },
    ]);
  });

  it("ignores rows without meaningful movement", () => {
    expect(
      buildSidebarReorderDeltas(
        new Map([
          ["project-a", 20],
          ["project-b", 60],
        ]),
        new Map([
          ["project-a", 20.2],
          ["project-b", 60],
        ]),
      ),
    ).toEqual([]);
  });

  it("collects top positions from the current rendered row map", () => {
    expect(
      collectElementTopPositions(
        new Map([
          ["project-a", makeElement(20)],
          ["project-b", makeElement(60)],
        ]),
      ),
    ).toEqual(
      new Map([
        ["project-a", 20],
        ["project-b", 60],
      ]),
    );
  });

  it("does not let a stale cleanup cancel a newer reorder animation", () => {
    const project = makeElement(20);
    const animationFrames: Array<() => void> = [];
    const timeouts: Array<() => void> = [];

    animateSidebarReorder(
      new Map([["project-a", project]]),
      [{ id: "project-a", deltaY: 40 }],
      {
        requestAnimationFrame: (callback) => animationFrames.push(callback),
        setTimeout: (callback) => timeouts.push(callback),
      },
    );

    animationFrames.shift()?.();
    expect(project.style.transition).toBe(SIDEBAR_REORDER_TRANSITION);
    expect(project.style.transform).toBe("translateY(0)");

    animateSidebarReorder(
      new Map([["project-a", project]]),
      [{ id: "project-a", deltaY: -40 }],
      {
        requestAnimationFrame: (callback) => animationFrames.push(callback),
        setTimeout: (callback) => timeouts.push(callback),
      },
    );

    animationFrames.shift()?.();
    expect(project.style.transition).toBe(SIDEBAR_REORDER_TRANSITION);
    expect(project.style.transform).toBe("translateY(0)");

    timeouts.shift()?.();
    expect(project.style.transition).toBe(SIDEBAR_REORDER_TRANSITION);
    expect(project.style.transform).toBe("translateY(0)");
    expect(project.style.willChange).toBe("transform");

    timeouts.shift()?.();
    expect(project.style.transition).toBe("");
    expect(project.style.transform).toBe("");
    expect(project.style.willChange).toBe("");
  });
});
