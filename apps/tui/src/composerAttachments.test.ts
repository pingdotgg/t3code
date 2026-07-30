import { describe, expect, it } from "bun:test";

import {
  extractPastedImagePath,
  findPromptImagePathLines,
  imageMimeTypeForPath,
  imageExtensionForMimeType,
  isSupportedImagePath,
  prepareComposerImage,
  prepareComposerImageBytes,
  removeComposerImage,
  removePromptLines,
  replacePromptLines,
  resolvePastedImagePath,
} from "./composerAttachments.ts";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("composer image attachments", () => {
  it("recognizes supported workspace image paths case-insensitively", () => {
    expect(isSupportedImagePath("docs/diagram.PNG")).toBe(true);
    expect(imageMimeTypeForPath("photo.jpeg")).toBe("image/jpeg");
    expect(imageExtensionForMimeType("image/png")).toBe("png");
    expect(imageExtensionForMimeType("image/jpeg;charset=binary")).toBe("jpg");
    expect(isSupportedImagePath("README.md")).toBe(false);
  });

  it("Given a terminal path paste, when it identifies a workspace image, then it resolves a safe relative path", () => {
    expect(
      resolvePastedImagePath(
        "'/workspace/project/docs/error screenshot.PNG'",
        "/workspace/project",
        "/home/olafura",
        "linux",
      ),
    ).toBe("docs/error screenshot.PNG");
    expect(
      resolvePastedImagePath(
        "./docs/error\\ screenshot.webp",
        "/workspace/project",
        "/home/olafura",
        "linux",
      ),
    ).toBe("docs/error screenshot.webp");
    expect(
      resolvePastedImagePath(
        "C:\\workspace\\project\\shots\\error.jpg",
        "C:\\workspace\\project",
        "C:\\Users\\olafura",
        "win32",
      ),
    ).toBe("shots\\error.jpg");
  });

  it("Given prompt prose or multiple paths, when image-path recognition runs, then it leaves the paste as text", () => {
    expect(
      resolvePastedImagePath(
        "please inspect docs/error.png",
        "/workspace/project",
        "/home/olafura",
        "linux",
      ),
    ).toBeNull();
    expect(
      resolvePastedImagePath(
        "This is not readable in the tui ~/Downloads/Screenshot\\ 2026-07-30\\ at\\ 12.09.22.png",
        "/workspace/project",
        "/home/olafura",
        "linux",
      ),
    ).toBeNull();
    expect(
      resolvePastedImagePath(
        "docs/one.png\ndocs/two.png",
        "/workspace/project",
        "/home/olafura",
        "linux",
      ),
    ).toBeNull();
  });

  it("Given a home-relative or explicit local image path, when it is recognized, then it resolves outside the workspace", () => {
    expect(
      resolvePastedImagePath(
        "~/Pictures/screenshot.png",
        "/workspace/project",
        "/home/olafura",
        "linux",
      ),
    ).toBe("/home/olafura/Pictures/screenshot.png");
    expect(
      resolvePastedImagePath(
        "~/Downloads/Screenshot\\ 2026-07-30\\ at\\ 12.09.22.png",
        "/workspace/project",
        "/home/olafura",
        "linux",
      ),
    ).toBe("/home/olafura/Downloads/Screenshot 2026-07-30 at 12.09.22.png");
    expect(
      resolvePastedImagePath(
        "/workspace/other/reference.webp",
        "/workspace/project",
        "/home/olafura",
        "linux",
      ),
    ).toBe("/workspace/other/reference.webp");
    expect(
      resolvePastedImagePath(
        "~\\Pictures\\screenshot.png",
        "C:\\workspace\\project",
        "C:\\Users\\olafura",
        "win32",
      ),
    ).toBe("C:\\Users\\olafura\\Pictures\\screenshot.png");
  });

  it("Given prompt prose containing an escaped home image path, when extracted, then it stages the image and preserves the prose", () => {
    expect(
      extractPastedImagePath(
        "This is not readable in the tui ~/Downloads/Screenshot\\ 2026-07-30\\ at\\ 12.09.22.png",
        "/workspace/project",
        "/home/olafura",
        "linux",
      ),
    ).toEqual({
      imagePath: "/home/olafura/Downloads/Screenshot 2026-07-30 at 12.09.22.png",
      remainingText: "This is not readable in the tui ",
    });
  });

  it("Given editor content with path-only image lines, when recognized, then successful attachments can be removed without changing prose", () => {
    const prompt =
      "Compare these screenshots:\n~/Pictures/before.png\n\n./docs/after.webp\nKeep this line.";
    const matches = findPromptImagePathLines(
      prompt,
      "/home/olafura/project",
      "/home/olafura",
      "linux",
    );
    expect(matches).toEqual([
      {
        lineIndex: 1,
        text: "~/Pictures/before.png",
        imagePath: "/home/olafura/Pictures/before.png",
      },
      {
        lineIndex: 3,
        text: "./docs/after.webp",
        imagePath: "docs/after.webp",
      },
    ]);
    expect(removePromptLines(prompt, new Set([1, 3]))).toBe(
      "Compare these screenshots:\n\nKeep this line.",
    );
  });

  it("Given editor prose containing an image path, when attached, then only the path is removed", () => {
    const prompt =
      "Please inspect ~/Downloads/Screenshot\\ 2026-07-30\\ at\\ 12.09.22.png before continuing.";
    const matches = findPromptImagePathLines(
      prompt,
      "/home/olafura/project",
      "/home/olafura",
      "linux",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.imagePath).toBe(
      "/home/olafura/Downloads/Screenshot 2026-07-30 at 12.09.22.png",
    );
    expect(replacePromptLines(prompt, new Map([[0, "Please inspect before continuing."]]))).toBe(
      "Please inspect before continuing.",
    );
  });

  it("builds an upload attachment and bounded RGBA preview", async () => {
    const decoded = {
      data: new Uint8Array([255, 0, 0, 255]),
      imageWidth: 1,
      imageHeight: 1,
    };
    let decodedBytes = 0;
    const image = await prepareComposerImage(
      "docs/diagram.png",
      {
        contents: PNG_BASE64,
        byteLength: 68,
        truncated: false,
      },
      async (encoded) => {
        decodedBytes = encoded.byteLength;
        return decoded;
      },
    );

    expect(decodedBytes).toBe(68);
    expect(image.relativePath).toBe("docs/diagram.png");
    expect(image.upload).toEqual({
      type: "image",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 68,
      dataUrl: `data:image/png;base64,${PNG_BASE64}`,
    });
    expect(image.preview).toBe(decoded);
  });

  it("Given clipboard image bytes, when prepared, then they use the same bounded upload path", async () => {
    const encoded = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));
    const preview = {
      data: new Uint8Array([255, 0, 0, 255]),
      imageWidth: 1,
      imageHeight: 1,
    };
    const image = await prepareComposerImageBytes(
      "clipboard-image-1.png",
      "image/png",
      encoded,
      async () => preview,
    );

    expect(image.relativePath).toBe("clipboard-image-1.png");
    expect(image.upload).toEqual({
      type: "image",
      name: "clipboard-image-1.png",
      mimeType: "image/png",
      sizeBytes: 68,
      dataUrl: `data:image/png;base64,${PNG_BASE64}`,
    });
    expect(image.preview).toBe(preview);
  });

  it("rejects truncated, empty, and malformed image payloads", async () => {
    const decoder = async () => ({
      data: new Uint8Array([0, 0, 0, 0]),
      imageWidth: 1,
      imageHeight: 1,
    });
    await expect(
      prepareComposerImage(
        "large.png",
        { contents: "AA==", byteLength: 11 * 1024 * 1024, truncated: true },
        decoder,
      ),
    ).rejects.toThrow("10MB");
    await expect(
      prepareComposerImage("empty.png", { contents: "", byteLength: 0, truncated: false }, decoder),
    ).rejects.toThrow("empty");
    await expect(
      prepareComposerImage(
        "bad.png",
        { contents: "not-base64", byteLength: 3, truncated: false },
        decoder,
      ),
    ).rejects.toThrow("base64");
  });

  it("Given a staged image, when it is removed, then the outgoing attachment list omits it", () => {
    const preview = {
      data: new Uint8Array([255, 0, 0, 255]),
      imageWidth: 1,
      imageHeight: 1,
    };
    const image = {
      relativePath: "docs/diagram.png",
      upload: {
        type: "image" as const,
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,AA==",
      },
      preview,
    };

    expect(removeComposerImage([image], image.relativePath)).toEqual([]);
  });
});
