import { describe, expect, it } from "vite-plus/test";

import { resolveFileContextMenuAbsolutePath } from "~/fileContextMenu";

import { binaryFileInfo, fileMenuTarget } from "./binaryFileInfo";

describe("binaryFileInfo", () => {
  it.each([
    ["/workspace/slides.PPTX", "slides.PPTX", "PowerPoint presentation"],
    ["C:\\work\\report.docx", "report.docx", "Word document"],
  ])("labels and allows document-like file %s", (path, name, kind) => {
    expect(binaryFileInfo(path)).toEqual({ name, kind, canOpenDefault: true });
  });

  it.each([
    "program.exe",
    "install.msi",
    "App.app",
    "run.sh",
    "run.command",
    "run.bat",
    "run.cmd",
    "run.ps1",
    "run.py",
    "run.js",
    "page.html",
    "image.svg",
    "slides.pptx.exe",
    "slides.pptm",
    "unknown.bin",
    "no-extension",
  ])("does not offer default-app open for %s", (path) => {
    expect(binaryFileInfo(path).canOpenDefault).toBe(false);
  });

  it("describes unknown formats without assuming an application", () => {
    expect(binaryFileInfo("data.bin").kind).toBe("BIN file");
    expect(binaryFileInfo("data").kind).toBe("Binary file");
  });
});

describe("fileMenuTarget", () => {
  it.each([
    "/tmp/files/brochure.pptx",
    "/brochure.pptx",
    "C:\\work\\brochure.pptx",
    "\\\\server\\share\\brochure.pptx",
  ])("lets the file menu act on %s", (path) => {
    expect(
      resolveFileContextMenuAbsolutePath({ environmentId: null, ...fileMenuTarget(path) }),
    ).toBe(path);
  });
});
