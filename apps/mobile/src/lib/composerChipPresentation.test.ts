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
    expect(composerChipSizeSuffix({ kind: "terminal" })).toBe("");
    expect(composerChipSizeSuffix({ kind: "file" })).toBe("");
    expect(composerChipSizeSuffix(undefined)).toBe("");
  });
});

describe("contextChipPresentation image detection", () => {
  it("draws a mentioned machine as a machine, not the generic file chip", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    expect(contextChipPresentation("environment")).toEqual({
      accent: "#3f9a4f",
      symbol: "server.rack",
      icon: null,
    });
  });

  it("treats a picture attached through the file picker as an image", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    expect(
      contextChipPresentation("file", { kind: "file", name: "IMG_4997.PNG", mimeType: "" }),
    ).toEqual({ accent: "#d55665", symbol: "photo", icon: "image" });
    expect(
      contextChipPresentation("file", {
        kind: "file",
        name: "shot",
        mimeType: "image/jpeg",
      }),
    ).toEqual({ accent: "#d55665", symbol: "photo", icon: "image" });
  });

  it("leaves genuine documents and videos alone", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    expect(
      contextChipPresentation("file", { kind: "file", name: "notes.txt", mimeType: "text/plain" }),
    ).toEqual({ accent: "#0090cd", symbol: "doc", icon: null });
    expect(
      contextChipPresentation("file", { kind: "file", name: "clip.mp4", mimeType: "video/mp4" }),
    ).toEqual({ accent: "#d06217", symbol: "play.rectangle", icon: "film" });
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

  it("keeps one composer glyph across every state, so only colour carries the status", async () => {
    const symbols = await Promise.all(
      [chip("open"), chip("open", true), chip("merged"), chip("closed")].map(
        async (pending) => (await pending).symbol,
      ),
    );
    expect(new Set(symbols)).toEqual(new Set(["git-pull-request"]));
  });

  it("gives message chips web's per-state pull request glyphs", async () => {
    expect((await chip("open")).icon).toBe("git-pull-request-arrow");
    expect((await chip("open", true)).icon).toBe("git-pull-request-draft");
    expect((await chip("merged")).icon).toBe("git-merge");
    expect((await chip("closed")).icon).toBe("git-pull-request-closed");
  });

  it("falls back to the generic pull request chip when the state is unknown", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    expect(
      contextChipPresentation("review-comment", {
        kind: "review-comment",
        sectionId: "pull-request:1",
      }).accent,
    ).toBe("#7079e4");
  });
});

describe("context chip kinds", () => {
  it("gives thread context its own teal chip instead of the file style", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    expect(contextChipPresentation("thread")).toMatchObject({
      accent: "#009c96",
      icon: "messages-square",
    });
  });

  it("shows unknown kinds as a neutral chip rather than a file", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    const presentation = contextChipPresentation("future-kind");
    expect(presentation.accent).toBeUndefined();
    expect(presentation.icon).toBe("circle-dashed");
  });
});
