import { describe, expect, it } from "vite-plus/test";

import {
  formatModelViewHash,
  modelAnnotationFileTarget,
  modelAnnotationPayload,
  modelViewFromHref,
  reconcileModelNotes,
  type ModelNote,
} from "./modelAnnotations";

const view = { position: [120, 80.5, -40] as const, target: [0, 0.25, 0] as const };

const note = (id: string, text: string, stale = false): ModelNote => ({
  id,
  text,
  point: [1.5, 2, -3],
  normal: [0, 1, 0],
  stale,
});

describe("model camera links", () => {
  it("round-trips a saved camera through a file link", () => {
    expect(formatModelViewHash(view)).toBe("#view=120,80.5,-40,0,0.25,0");
    expect(modelViewFromHref(`out/bracket.stl${formatModelViewHash(view)}`)).toEqual(view);
    expect(modelViewFromHref("out/bracket.stl#view=120%2C80.5%2C-40%2C0%2C0.25%2C0")).toEqual(view);
  });

  it.each([
    "out/bracket.stl",
    "out/bracket.stl#L12",
    "out/bracket.stl#view=1,2,3,0,0",
    "out/bracket.stl#view=1,2,3,0,0,0,9",
    "out/bracket.stl#view=1,2,NaN,0,0,0",
    "out/bracket.stl#view=1,2,Infinity,0,0,0",
    "out/bracket.stl#view=1,2,3,1,2,3",
    "out/bracket.stl#view=1,2,,0,0,0",
    "out/bracket.stl#review=1,2,3,0,0,0",
  ])("ignores %s", (href) => {
    expect(modelViewFromHref(href)).toBeNull();
  });
});

describe("model notes after the geometry changes", () => {
  it("keeps notes placed on the same geometry", () => {
    const notes = [note("a", "Widen")];
    expect(reconcileModelNotes({ fingerprint: "g1", notes }, "g1")).toBe(notes);
    expect(reconcileModelNotes(undefined, "g1")).toEqual([]);
  });

  it("marks every note stale instead of moving it onto changed geometry", () => {
    const notes = [note("a", "Widen"), note("b", "Keep", true)];
    expect(reconcileModelNotes({ fingerprint: "g1", notes }, "g2")).toEqual([
      note("a", "Widen", true),
      note("b", "Keep", true),
    ]);
  });
});

describe("model notes as a chat annotation", () => {
  const screenshot = { dataUrl: "data:image/png;base64,AA==", width: 800, height: 600 };
  const payload = (overrides: Partial<Parameters<typeof modelAnnotationPayload>[0]>) =>
    modelAnnotationPayload({
      id: "a1",
      name: "hinge (v3).stl",
      linkPath: "out/hinge (v3).stl",
      view,
      notes: [note("a", "Pin hole looks tight.\n  Open it to 3.2 mm."), note("b", "Keep it")],
      screenshot: { ...screenshot, earlier: false },
      createdAt: "2026-11-20T12:00:00.000Z",
      ...overrides,
    });

  it("numbers each note under a file link that restores the camera", () => {
    const annotation = payload({});
    expect(annotation).toMatchObject({
      pageTitle: "hinge (v3).stl",
      pageUrl: "out/hinge%20%28v3%29.stl#view=120,80.5,-40,0,0.25,0",
      comment: [
        "1. Pin hole looks tight. Open it to 3.2 mm. (surface point 1.5, 2, -3)",
        "2. Keep it (surface point 1.5, 2, -3)",
      ].join("\n"),
      screenshot: { ...screenshot, cropRect: { x: 0, y: 0, width: 800, height: 600 } },
    });
    expect(modelAnnotationFileTarget(annotation.pageUrl)).toEqual({
      path: "out/hinge (v3).stl",
      view,
    });
  });

  it.each(["out/bracket#2.stl", "out/bracket?.stl", "bracket%23.glb"])(
    "reopens a model with the literal filename %s",
    (linkPath) => {
      const { pageUrl } = payload({ linkPath });
      expect(modelAnnotationFileTarget(pageUrl)).toEqual({ path: linkPath, view });
    },
  );

  it.each(["out/report.txt", "file:///tmp/report.html"])(
    "ignores a camera on the non-model file %s",
    (path) => {
      expect(modelViewFromHref(path + formatModelViewHash(view))).toBeNull();
    },
  );

  it("says when notes and the screenshot predate the current geometry", () => {
    expect(
      payload({
        notes: [note("a", "Countersink [M3]", true)],
        screenshot: { ...screenshot, earlier: true },
      }).comment,
    ).toBe(
      [
        "1. Countersink [M3] (placed on an earlier version of the model, so its point may no longer match)",
        "The screenshot shows the model before it last changed.",
      ].join("\n"),
    );
  });

  it.each([
    ["an attachment", payload({ linkPath: null }).pageUrl],
    ["a web page", "https://example.com/app#view=1,2,3,0,0,0"],
    ["a local page", "file:///tmp/report.html"],
    ["a file link without a camera", "out/hinge.stl"],
  ])("opens nothing for %s", (_case, pageUrl) => {
    expect(modelAnnotationFileTarget(pageUrl)).toBeNull();
  });
});
