import { describe, expect, it } from "vite-plus/test";

import type { ComposerThreadDraftState } from "../../composerDraftStore.ts";
import { resolveBoardDraftPreview } from "./BoardDraftCard.tsx";

function draft(overrides: Partial<ComposerThreadDraftState> = {}): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
    ...overrides,
  };
}

describe("resolveBoardDraftPreview", () => {
  it("omits drafts without user content", () => {
    expect(resolveBoardDraftPreview(draft())).toBeNull();
  });

  it("uses the first prompt line as the summary", () => {
    expect(resolveBoardDraftPreview(draft({ prompt: "  First line\nSecond line  " }))).toBe(
      "First line",
    );
  });

  it("falls back to the attachment count without double-counting hydrated images", () => {
    const image = {
      type: "image" as const,
      id: "image-1",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 42,
      dataUrl: "data:image/png;base64,aW1hZ2U=",
    };
    expect(
      resolveBoardDraftPreview(
        draft({
          persistedAttachments: [image],
          images: [
            {
              ...image,
              previewUrl: image.dataUrl,
              file: new File([], image.name, { type: image.mimeType }),
            },
          ],
        }),
      ),
    ).toBe("1 attachment");
  });
});
