import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PreviewRenderControlMessage, PreviewRenderMessage } from "./preview.ts";

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("PreviewRenderMessage", () => {
  it("accepts ready messages from the preview runtime", () => {
    expect(
      decodes(PreviewRenderMessage, {
        source: "forma-preview",
        type: "ready",
        loadToken: "preview-load-token",
        previewId: "src/components/ui/button.preview.tsx",
        caseId: "default",
      }),
    ).toBe(true);
  });
});

describe("PreviewRenderControlMessage", () => {
  it("accepts case and viewport updates from the parent surface", () => {
    expect(
      decodes(PreviewRenderControlMessage, {
        source: "forma-preview-parent",
        type: "update",
        loadToken: "preview-load-token",
        caseId: "large",
        viewportWidth: 1024,
      }),
    ).toBe(true);
  });

  it("accepts responsive viewport updates", () => {
    expect(
      decodes(PreviewRenderControlMessage, {
        source: "forma-preview-parent",
        type: "update",
        loadToken: "preview-load-token",
        caseId: "default",
        viewportWidth: null,
      }),
    ).toBe(true);
  });

  it("rejects invalid viewport widths", () => {
    expect(
      decodes(PreviewRenderControlMessage, {
        source: "forma-preview-parent",
        type: "update",
        loadToken: "preview-load-token",
        caseId: "default",
        viewportWidth: 0,
      }),
    ).toBe(false);
  });
});
