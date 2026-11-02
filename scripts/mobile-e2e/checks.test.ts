import { describe, expect, it } from "@effect/vitest";

import { layoutChecks, type Snapshot, type SnapshotNode } from "./checks.ts";

const APP = "com.t3tools.t3code.dev";
const node = (index: number, fields: Omit<SnapshotNode, "index">): SnapshotNode => ({
  index,
  hittable: true,
  kind: "button",
  ...fields,
});

const failing = (snapshot: Snapshot) =>
  Object.fromEntries(
    layoutChecks(snapshot, APP)
      .filter((item) => !item.pass)
      .map((item) => [item.name, item.detail]),
  );

describe("layoutChecks", () => {
  it("flags broken chrome but not scrolled content, nested controls or duplicates", () => {
    const snapshot: Snapshot = {
      appBundleId: APP,
      viewport: { width: 400, height: 800 },
      nodes: [
        node(0, {
          kind: "application",
          hittable: false,
          rect: { x: 0, y: 0, width: 400, height: 800 },
        }),
        node(1, {
          kind: "scroll-area",
          parentIndex: 0,
          rect: { x: 0, y: 0, width: 400, height: 700 },
        }),
        node(2, {
          label: "Row past the edge",
          parentIndex: 1,
          rect: { x: 0, y: 680, width: 400, height: 60 },
        }),
        node(3, { label: "Send", parentIndex: 0, rect: { x: 340, y: 770, width: 80, height: 40 } }),
        node(4, {
          label: "Card",
          parentIndex: 0,
          rect: { x: 10, y: 100, width: 200, height: 100 },
        }),
        node(5, { label: "Inner", parentIndex: 4, rect: { x: 20, y: 110, width: 50, height: 40 } }),
        node(6, { label: "Twin", parentIndex: 0, rect: { x: 10, y: 300, width: 80, height: 40 } }),
        node(7, { label: "Twin", parentIndex: 0, rect: { x: 10, y: 300, width: 80, height: 40 } }),
        node(8, {
          label: "Plan",
          parentIndex: 0,
          rect: { x: 100, y: 400, width: 100, height: 40 },
        }),
        node(9, {
          label: "Stop",
          parentIndex: 0,
          rect: { x: 120, y: 405, width: 100, height: 40 },
        }),
        node(10, {
          kind: "text-field",
          label: "Message",
          parentIndex: 0,
          rect: { x: 0, y: 600, width: 300, height: 40 },
        }),
        node(12, {
          label: "Row of a covered screen",
          parentIndex: 1,
          rect: { x: 100, y: 400, width: 100, height: 40 },
        }),
        node(11, {
          kind: "keyboard",
          hittable: false,
          rect: { x: 0, y: 500, width: 400, height: 300 },
        }),
      ],
    };

    expect(failing(snapshot)).toEqual({
      "no control cut off by the screen edge": '"Send" at 340,770 80×40',
      "no controls stacked on each other": '"Plan" and "Stop"',
      "no input under the keyboard": '"Message" at 0,600 300×40',
    });
  });

  it("flags an error screen and controls under Android system bars", () => {
    const snapshot: Snapshot = {
      appBundleId: APP,
      viewport: { width: 1080, height: 2400 },
      nodes: [
        node(0, {
          kind: "text",
          label: "Render Error",
          rect: { x: 0, y: 200, width: 600, height: 60 },
        }),
        node(1, {
          kind: "text",
          systemBar: "status",
          bundleId: "com.android.systemui",
          rect: { x: 0, y: 0, width: 1080, height: 60 },
        }),
        node(2, {
          label: "Search",
          bundleId: APP,
          rect: { x: 900, y: 10, width: 120, height: 80 },
        }),
      ],
    };

    expect(Object.keys(failing(snapshot))).toEqual([
      "no error screen",
      "no control under a system bar",
    ]);
  });
});
