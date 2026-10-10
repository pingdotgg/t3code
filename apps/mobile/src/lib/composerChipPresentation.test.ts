import { describe, expect, it } from "vite-plus/test";

describe("composerChipSizeSuffix", () => {
  it("labels attachment records with a human size, matching web's chip", async () => {
    const { composerChipSizeSuffix } = await import("./composerChipPresentation");
    expect(composerChipSizeSuffix({ kind: "file", sizeBytes: 1024 })).toBe("1 KB");
    expect(composerChipSizeSuffix({ kind: "file", sizeBytes: 3_700_000 })).toBe("3.5 MB");
    expect(composerChipSizeSuffix({ kind: "image", sizeBytes: 2048 })).toBe("2 KB");
  });

  it("adds nothing for records that carry no bytes", async () => {
    const { composerChipSizeSuffix } = await import("./composerChipPresentation");
    // Terminal/review/PR chips have no size to show.
    expect(composerChipSizeSuffix({ kind: "terminal" })).toBe("");
    expect(composerChipSizeSuffix({ kind: "file" })).toBe("");
    expect(composerChipSizeSuffix(undefined)).toBe("");
  });
});

describe("contextChipPresentation image detection", () => {
  it("treats a picture attached through the file picker as an image", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    // The document picker types every pick as `file`, so the name has to carry the intent.
    expect(
      contextChipPresentation("file", { kind: "file", name: "IMG_4997.PNG", mimeType: "" }),
    ).toEqual({ accent: "#d55665", symbol: "photo" });
    expect(
      contextChipPresentation("file", {
        kind: "file",
        name: "shot",
        mimeType: "image/jpeg",
      }),
    ).toEqual({ accent: "#d55665", symbol: "photo" });
  });

  it("leaves genuine documents and videos alone", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    expect(
      contextChipPresentation("file", { kind: "file", name: "notes.txt", mimeType: "text/plain" }),
    ).toEqual({ accent: "#0090cd", symbol: "doc" });
    expect(
      contextChipPresentation("file", { kind: "file", name: "clip.mp4", mimeType: "video/mp4" }),
    ).toEqual({ accent: "#d06217", symbol: "play.rectangle" });
  });
});

describe("pull request chip status", () => {
  const chip = async (state: string, isDraft = false) => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    return contextChipPresentation("review-comment", {
      kind: "review-comment",
      sectionId: "pull-request:10978",
      pullRequest: { state, isDraft },
    });
  };

  it("colours a pull request by its state, the way web and the forge do", async () => {
    expect((await chip("open")).accent).toBe("#009f6e");
    expect((await chip("open", true)).accent).toBe("#7f8793");
    expect((await chip("merged")).accent).toBe("#8a70dd");
    expect((await chip("closed")).accent).toBe("#d55665");
  });

  it("keeps one glyph across every state, so only colour carries the status", async () => {
    // Web draws a fixed `git-pull-request` and encodes state in colour alone. A per-state glyph
    // here would put mobile out of step with it.
    const symbols = await Promise.all(
      [chip("open"), chip("open", true), chip("merged"), chip("closed")].map(
        async (pending) => (await pending).symbol,
      ),
    );
    expect(new Set(symbols)).toEqual(new Set(["git-pull-request"]));
  });

  it("falls back to the generic pull request chip when the state is unknown", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    // An older server may send no metadata at all; the chip still has to render.
    expect(
      contextChipPresentation("review-comment", {
        kind: "review-comment",
        sectionId: "pull-request:1",
      }).accent,
    ).toBe("#7079e4");
  });
});
