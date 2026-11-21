import { modelAnnotationPayload } from "@t3tools/client-runtime/model-preview/annotations";
import { OrchestrationMessageContext } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { referencedComposerContext } from "../../lib/composerContext";
import { modelAnnotationComposerContent, modelAnnotationDrafts } from "./modelAnnotationDraft";

const decodeContext = Schema.decodeSync(OrchestrationMessageContext);

const annotation = (comment: string) => ({
  ...modelAnnotationPayload({
    id: "a1",
    name: "hinge.stl",
    linkPath: "out/hinge.stl",
    view: { position: [1, 2, 3], target: [0, 0, 0] },
    notes: [
      { id: "n1", number: 1, text: comment, point: [0, 0, 0], normal: [0, 1, 0], stale: false },
    ],
    screenshot: {
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      width: 4,
      height: 2,
      earlier: false,
    },
    createdAt: "2026-11-20T12:00:00.000Z",
  }),
});

describe("model notes staged in a mobile draft", () => {
  it("sends the notes with their transparent PNG screenshot as valid message context", () => {
    const content = modelAnnotationComposerContent(annotation("Widen the slot"), () => "s1");
    expect(content).not.toBeNull();
    const { text, context, attachments } = content!;
    // The draft keeps only context its text references; the screenshot rides on the annotation.
    expect(referencedComposerContext(text, context)).toEqual(context);
    expect(decodeContext(context)).toEqual(context);
    expect(attachments).toEqual([
      expect.objectContaining({
        id: "s1",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      }),
    ]);
    expect(context.records[0]).toMatchObject({
      kind: "preview-annotation",
      pageUrl: "./out/hinge.stl#view=1,2,3,0,0,0",
      comment: "1. Widen the slot (surface point 0, 0, 0)",
      screenshotContextId: context.records[1]!.contextId,
    });
    // The composer shows it as one card that owns the screenshot.
    expect(modelAnnotationDrafts(context, attachments)).toEqual([
      {
        record: context.records[0],
        notes: [{ number: 1, text: "Widen the slot", stale: false }],
        target: { path: "out/hinge.stl", view: { position: [1, 2, 3], target: [0, 0, 0] } },
        screenshotId: "s1",
      },
    ]);
  });

  it("keeps a long note readable on a draft card with a saved view", () => {
    const noteText = "x".repeat(7_650);
    const content = modelAnnotationComposerContent(annotation(noteText), () => "s1");
    expect(() => decodeContext(content!.context)).not.toThrow();
    expect(modelAnnotationDrafts(content!.context, content!.attachments)).toEqual([
      expect.objectContaining({
        notes: [{ number: 1, text: noteText, stale: false }],
        target: { path: "out/hinge.stl", view: { position: [1, 2, 3], target: [0, 0, 0] } },
        screenshotId: "s1",
      }),
    ]);
  });
});
