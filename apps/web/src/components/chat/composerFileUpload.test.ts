import { describe, expect, it } from "vite-plus/test";

import { prepareComposerFileUpload } from "./composerFileUpload";

describe("prepareComposerFileUpload", () => {
  it("keeps images as attachments and resolves other files through Electron", () => {
    const image = { name: "photo.png", type: "image/png", path: "C:\\files\\photo.png" };
    const document = { name: "notes.txt", type: "text/plain", path: "C:\\files\\notes.txt" };

    expect(
      prepareComposerFileUpload([image, document], {
        allowLocalPaths: true,
        getPathForFile: (file) => file.path,
      }),
    ).toEqual({
      imageFiles: [image],
      paths: ["C:\\files\\notes.txt"],
      unresolvedNames: [],
      unsupportedNames: [],
    });
  });

  it("reports non-image files on a remote desktop environment", () => {
    const image = { name: "photo.png", type: "image/png" };
    const document = { name: "notes.txt", type: "text/plain" };
    const getPathForFile = (file: typeof document) => `C:\\files\\${file.name}`;

    expect(
      prepareComposerFileUpload([image, document], { allowLocalPaths: false, getPathForFile }),
    ).toEqual({
      imageFiles: [image],
      paths: [],
      unresolvedNames: [],
      unsupportedNames: ["notes.txt"],
    });
  });

  it("ignores non-image files outside the desktop app", () => {
    const image = { name: "photo.png", type: "image/png" };
    const document = { name: "notes.txt", type: "text/plain" };

    expect(prepareComposerFileUpload([image, document], { allowLocalPaths: false })).toEqual({
      imageFiles: [image],
      paths: [],
      unresolvedNames: [],
      unsupportedNames: [],
    });
  });

  it("reports files whose local path is unavailable", () => {
    const document = { name: "notes.txt", type: "text/plain" };

    expect(
      prepareComposerFileUpload([document], {
        allowLocalPaths: true,
        getPathForFile: () => "",
      }).unresolvedNames,
    ).toEqual(["notes.txt"]);
  });
});
