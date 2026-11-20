import { describe, expect, it } from "vite-plus/test";

import {
  formatModelViewHash,
  modelAnnotationFileTarget,
  modelAnnotationNotes,
  modelAnnotationPayload,
  modelCameraStatus,
  modelNotesFitAnnotation,
  modelViewFromHash,
  modelViewFromHref,
  reconcileModelNotes,
  rememberModelPreview,
  restoreModelPins,
  type ModelNote,
  type ModelPreviewMemory,
} from "./annotations.ts";

const view = { position: [120, 80.5, -40] as const, target: [0, 0.25, 0] as const };

const note = (number: number, text: string, stale = false): ModelNote => ({
  id: `n${number}`,
  number,
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
    // A native route carries the fragment alone.
    expect(modelViewFromHash(formatModelViewHash(view))).toEqual(view);
    const closeUp = {
      position: [0.1234567890123456, 3e-12, 1.2e21],
      target: [0.123456789012344, 0, 1.2e21],
    } as const;
    expect(modelViewFromHref(`out/bracket.stl${formatModelViewHash(closeUp)}`)).toEqual(closeUp);
  });

  it.each([
    [
      { position: [0, 0, 10], target: [0, 0, 0] },
      { azimuth: 0, elevation: 0 },
    ],
    [
      { position: [11, 5, 1], target: [1, 5, 1] },
      { azimuth: 90, elevation: 0 },
    ],
    [
      { position: [2, 12, 3], target: [2, 2, 3] },
      { azimuth: 0, elevation: 90 },
    ],
    [
      { position: [-1, 1, 0], target: [0, 0, 0] },
      { azimuth: -90, elevation: 45 },
    ],
  ] as const)("describes the camera %j as %j", (camera, status) => {
    expect(modelCameraStatus(camera)).toEqual(status);
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
    "out/report.txt#view=120,80.5,-40,0,0.25,0",
    "file:///tmp/report.html#view=120,80.5,-40,0,0.25,0",
  ])("ignores %s", (href) => {
    expect(modelViewFromHref(href)).toBeNull();
  });
});

describe("model notes after the geometry changes", () => {
  it("keeps notes placed on the same geometry", () => {
    const notes = [note(1, "Widen")];
    expect(reconcileModelNotes({ fingerprint: "g1", notes }, "g1")).toBe(notes);
    expect(reconcileModelNotes(undefined, "g1")).toEqual([]);
  });

  it("restores pins for the same attachment without giving them to another with identical bytes", () => {
    const first = {
      fingerprint: "g1",
      notes: [note(1, "Keep this face")],
      view,
      wireframe: false,
      lastPinNumber: 1,
      capture: null,
      earlierCapture: null,
    };
    const memory = rememberModelPreview({}, "attachment:first", first);
    expect(restoreModelPins(memory["attachment:second"], "g1").notes).toEqual([]);
    expect(restoreModelPins(memory["attachment:first"], "g1").notes).toEqual(first.notes);
  });

  it("keeps the most recently viewed models within its bound", () => {
    const entry = (fingerprint: string): ModelPreviewMemory => ({
      fingerprint,
      notes: [],
      view,
      wireframe: false,
      lastPinNumber: 0,
      capture: null,
      earlierCapture: null,
    });
    let memory: Readonly<Record<string, ModelPreviewMemory>> = {};
    for (let index = 0; index < 21; index++) {
      memory = rememberModelPreview(memory, `m${index}`, entry(`g${index}`));
    }
    memory = rememberModelPreview(memory, "m1", entry("g1b"));
    expect(Object.keys(memory)).toHaveLength(20);
    expect(memory.m0).toBeUndefined();
    expect(Object.keys(memory).at(-1)).toBe("m1");
    expect(memory.m1?.fingerprint).toBe("g1b");
  });

  it("marks every note stale instead of moving it onto changed geometry", () => {
    const notes = [note(1, "Widen"), note(2, "Keep", true)];
    expect(reconcileModelNotes({ fingerprint: "g1", notes }, "g2")).toEqual([
      note(1, "Widen", true),
      note(2, "Keep", true),
    ]);
  });

  it("preserves the original capture alongside evidence for new pins after a reload", () => {
    const original = {
      screenshot: { dataUrl: "data:image/png;base64,AA==", width: 800, height: 600 },
      view,
    };
    const revised = {
      screenshot: { dataUrl: "data:image/png;base64,AQ==", width: 800, height: 600 },
      view,
    };
    const first = restoreModelPins(
      {
        fingerprint: "g1",
        notes: [note(1, "First pin")],
        capture: original,
        earlierCapture: null,
      },
      "g2",
    );
    expect(first).toEqual({
      notes: [note(1, "First pin", true)],
      capture: null,
      earlierCapture: original,
    });
    const saved = {
      fingerprint: "g2",
      ...first,
      capture: revised,
      notes: [...first.notes, note(2, "Second pin")],
    };
    expect(restoreModelPins(saved, "g2")).toEqual({
      notes: [note(1, "First pin", true), note(2, "Second pin")],
      capture: revised,
      earlierCapture: original,
    });
    expect(restoreModelPins(saved, "g3")).toEqual({
      notes: [note(1, "First pin", true), note(2, "Second pin", true)],
      capture: null,
      earlierCapture: original,
    });
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
      notes: [note(1, "Pin hole looks tight.\n  Open it to 3.2 mm."), note(2, "Keep it")],
      screenshot: { ...screenshot, earlier: false },
      createdAt: "2026-11-20T12:00:00.000Z",
      ...overrides,
    });

  it("numbers each note under a file link that restores the camera", () => {
    const annotation = payload({});
    expect(annotation).toMatchObject({
      pageTitle: "hinge (v3).stl",
      pageUrl: "./out/hinge%20%28v3%29.stl#view=120,80.5,-40,0,0.25,0",
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

  it.each([
    "out/bracket#2.stl",
    "out/bracket?.stl",
    "bracket%23.glb",
    "🧩 models/a:b (v3) & draft.3mf",
    "example.com/arm.stl",
    "../arm.stl",
    "/tmp/arm.stl",
    "C:\\Models\\arm.stl",
  ])("reopens a model with the literal filename %s", (linkPath) => {
    const { pageUrl } = payload({ linkPath });
    expect(modelAnnotationFileTarget(pageUrl)).toEqual({ path: linkPath, view });
  });

  it("says when notes and the screenshot predate the current geometry", () => {
    expect(
      payload({
        notes: [note(1, "Countersink [M3]", true)],
        screenshot: { ...screenshot, earlier: true },
      }).comment,
    ).toBe(
      [
        "1. Countersink [M3] (placed on an earlier version of the model, so its point may no longer match)",
        "The screenshot shows the model before it last changed.",
        "The original screenshot shows one saved revision. Pins added on other revisions may be absent, and removed pins may still appear.",
      ].join("\n"),
    );
  });

  it("lists the notes back from the comment it wrote", () => {
    expect(
      modelAnnotationNotes(
        payload({
          notes: [note(1, "Fillet (2 mm)\u2028here"), note(3, "Counter\u2029sink\u0085this", true)],
          screenshot: { ...screenshot, earlier: true },
        }).comment,
      ),
    ).toEqual({
      notes: [
        { number: 1, text: "Fillet (2 mm) here", stale: false },
        { number: 3, text: "Counter sink this", stale: true },
      ],
      earlier: true,
    });
    expect(modelAnnotationNotes("Make the header bigger")).toBeNull();
    expect(modelAnnotationNotes("")).toBeNull();
  });

  it("refuses to stage a batch that cannot carry every note", () => {
    const notes = Array.from({ length: 100 }, (_, index) => note(index + 1, "Widen", true));
    expect(modelNotesFitAnnotation(notes)).toBe(false);
    expect(() => payload({ notes })).toThrow(RangeError);
  });

  it("keeps every saved note whole after the geometry changes", () => {
    const notes = Array.from({ length: 12 }, (_, index) => note(index + 1, "🧩".repeat(280)));
    expect(modelNotesFitAnnotation(notes)).toBe(true);
    expect(modelNotesFitAnnotation([...notes, note(13, "x".repeat(250))])).toBe(false);
    const changed = reconcileModelNotes({ fingerprint: "before", notes }, "after");
    const comment = payload({
      notes: changed,
      screenshot: { ...screenshot, earlier: true },
    }).comment;
    expect(modelAnnotationNotes(comment)).toEqual({
      earlier: true,
      notes: notes.map(({ number, text }) => ({ number, text, stale: true })),
    });
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
