import { Schema } from "effect";
import { expect, it, vi } from "vite-plus/test";

import {
  hydrateImageEditorSession,
  imageEditorDocumentForAttachment,
  PersistedImageEditorSession,
  serializeImageEditorSession,
  type ImageEditorSession,
} from "./imageEditorSession";

const originalDataUrl = "data:image/png;base64,AP9BQg==";
const decodeSession = Schema.decodeUnknownSync(PersistedImageEditorSession);

function sourceSession(): ImageEditorSession {
  return {
    originalFile: new File([new Uint8Array([0, 255, 65, 66])], "original.png", {
      type: "image/png",
    }),
    originalSource: {
      kind: "snap-shot",
      appName: "Finder",
      windowTitle: "Pictures",
      capturedAt: "2026-11-15T12:00:00.000Z",
    },
    options: { instructions: "Keep warm lighting", removeBackground: true, aspectRatio: "4:5" },
    stagedRequest: {
      imageIds: ["gif", "source", "guidance", "mask"],
      prompt: "Frame-specific instructions",
      animation: { originalId: "gif", context: "Frame 1: 100ms; frame 2: 250ms" },
    },
    document: {
      width: 400,
      height: 300,
      crop: { x: 20, y: 30, width: 300, height: 200 },
      objects: [
        {
          id: "caption",
          kind: "text",
          x: 40,
          y: 50,
          width: 200,
          height: 80,
          color: "#3b82f6",
          strokeWidth: 2,
          rotation: 12,
          text: "New caption\nSecond line",
          fontFamily: "sans-serif",
          fontSize: 30,
          align: "center",
          letterSpacing: 1,
          wordSpacing: 2,
          lineHeight: 1.5,
          stretch: 1.2,
          curve: 4,
        },
        {
          id: "pin",
          kind: "pin",
          x: 100,
          y: 100,
          width: 32,
          height: 32,
          color: "#ef4444",
          strokeWidth: 2,
          rotation: 0,
          comment: "Repair this corner",
        },
      ],
    },
  };
}

it("round-trips original bytes, screenshot context, crop and editable layers across JSON persistence", async () => {
  const previous = globalThis.FileReader;
  vi.stubGlobal(
    "FileReader",
    class extends EventTarget {
      result: string | null = null;
      error: unknown = null;
      async readAsDataURL(file: File) {
        this.result = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
        this.dispatchEvent(new Event("load"));
      }
    },
  );
  using _reader = { [Symbol.dispose]: () => vi.stubGlobal("FileReader", previous) };
  const source = sourceSession();
  const persisted = await serializeImageEditorSession(source);
  expect(persisted.originalDataUrl).toBe(originalDataUrl);
  const decoded = decodeSession(JSON.parse(JSON.stringify(persisted)));
  const restored = hydrateImageEditorSession(decoded);
  expect(restored.document).toEqual(source.document);
  expect(restored.originalSource).toEqual(source.originalSource);
  expect(restored.options).toEqual(source.options);
  expect(restored.stagedRequest).toEqual(source.stagedRequest);
  const attachmentDocument = imageEditorDocumentForAttachment(source.document, {
    width: 150,
    height: 100,
  });
  expect(attachmentDocument).toMatchObject({
    width: 150,
    height: 100,
    crop: null,
    objects: [
      {
        id: "caption",
        x: 10,
        y: 10,
        width: 100,
        height: 40,
        fontSize: 15,
        letterSpacing: 0.5,
        wordSpacing: 1,
        curve: 2,
        rotation: 12,
        strokeWidth: 1,
      },
      { id: "pin", x: 40, y: 35, width: 16, height: 16, strokeWidth: 1 },
    ],
  });
  expect(restored.originalFile.name).toBe(source.originalFile.name);
  expect(restored.originalFile.type).toBe("image/png");
  expect(new Uint8Array(await restored.originalFile.arrayBuffer())).toEqual(
    new Uint8Array(await source.originalFile.arrayBuffer()),
  );
});

it("rejects invalid geometry, duplicated layer identities and malformed original image data", () => {
  const source = sourceSession();
  const persisted = { document: source.document, originalDataUrl, originalName: "original.png" };
  for (const document of [
    { ...source.document, width: Infinity },
    { ...source.document, height: 0 },
    { ...source.document, crop: { x: 390, y: 0, width: 30, height: 10 } },
    { ...source.document, objects: [source.document.objects[0], source.document.objects[0]] },
    { ...source.document, objects: [{ ...source.document.objects[0], rotation: NaN }] },
    { ...source.document, objects: [{ ...source.document.objects[0], color: "<script>" }] },
    { ...source.document, objects: [{ ...source.document.objects[0], fontSize: -1 }] },
    { ...source.document, objects: [{ ...source.document.objects[0], kind: "unknown" }] },
  ])
    expect(() => decodeSession({ ...persisted, document })).toThrow();
  for (const originalDataUrl of [
    "https://example.com/image.png",
    "data:text/html;base64,QUJDRA==",
    "data:image/png;base64,%%%",
    "data:image/png;base64,A",
    "data:image/png;base64,",
  ]) {
    expect(() => decodeSession({ ...persisted, originalDataUrl })).toThrow();
  }
});

it("restores stroke families and legacy text without word spacing while rejecting corrupt path points", () => {
  const source = sourceSession();
  const text = { ...source.document.objects[0]! };
  if (text.kind !== "text") throw new Error("Expected text fixture");
  delete text.wordSpacing;
  const objects = [
    text,
    ...(["freehand", "remove", "arrow"] as const).map((kind) => ({
      id: kind,
      kind,
      x: -10,
      y: 20,
      width: 50,
      height: 30,
      rotation: 45,
      color: "#3b82f6",
      strokeWidth: 2,
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 30 },
      ],
    })),
  ];
  const persisted = {
    originalDataUrl,
    originalName: "original.png",
    document: { ...source.document, objects },
  };
  expect(hydrateImageEditorSession(decodeSession(persisted)).document.objects).toEqual(objects);
  const scaled = imageEditorDocumentForAttachment(persisted.document, { width: 150, height: 100 });
  expect(scaled.objects[1]).toMatchObject({
    x: -15,
    y: -5,
    width: 25,
    height: 15,
    rotation: 45,
    points: [
      { x: 0, y: 0 },
      { x: 25, y: 15 },
    ],
  });
  for (const points of [[], [{ x: Infinity, y: 0 }], [{ x: 0, y: NaN }]]) {
    expect(() =>
      decodeSession({
        ...persisted,
        document: { ...source.document, objects: [{ ...objects[1], points }] },
      }),
    ).toThrow();
  }
});
