import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fileChipClipboardPath,
  fileChipMenu,
  fileChipShareSource,
  resolveFileChipTarget,
} from "./fileChipMenu";

it("copies native paths from a relative file chip in a Windows workspace", () => {
  const target = resolveFileChipTarget("reports/Device Users.csv", "C:/repo");
  if (!target) throw new Error("File-chip target unavailable");
  expect(fileChipClipboardPath(target, "copy-full-path")).toBe(
    String.raw`C:\repo\reports\Device Users.csv`,
  );
  expect(fileChipClipboardPath(target, "copy-relative-path")).toBe(
    String.raw`reports\Device Users.csv`,
  );
});

describe("resolveFileChipTarget", () => {
  it("resolves a workspace-relative link to both paths", () => {
    expect(resolveFileChipTarget("src/app.ts:12", "/repo")).toEqual({
      fullPath: "/repo/src/app.ts",
      relativePath: "src/app.ts",
    });
  });

  it("resolves home links for navigation and menu actions", () => {
    expect(resolveFileChipTarget("~/.agents/AGENTS.md:314", "/home/maria/repo")).toEqual({
      fullPath: "/home/maria/.agents/AGENTS.md",
    });
    expect(resolveFileChipTarget("~/repo/src/main.ts:12", "/home/maria/repo")).toEqual({
      fullPath: "/home/maria/repo/src/main.ts",
      relativePath: "src/main.ts",
    });
    expect(resolveFileChipTarget("~/.agents/AGENTS.md", "C:\\Users\\maria\\repo")).toEqual({
      fullPath: "C:\\Users\\maria\\.agents\\AGENTS.md",
    });
  });

  it("ignores links that are not files or cannot be opened", () => {
    expect(resolveFileChipTarget("https://example.com/app.ts", "/repo")).toBeNull();
    expect(resolveFileChipTarget("~/report.md", "/repo")).toBeNull();
    expect(resolveFileChipTarget("../other/file.ts", "/repo")).toBeNull();
  });
});

describe("file chip downloads", () => {
  const threadId = ThreadId.make("thread-1");

  it.each([
    [
      "/tmp/maria-counter/maria-counter-final.mp4",
      "/tmp/maria-counter/maria-counter-final.mp4",
      "video/mp4",
    ],
    ["/tmp/take%2520%23one.mp4:12", "/tmp/take%20#one.mp4", "video/mp4"],
    ["/tmp/report.pdf", "/tmp/report.pdf", "application/pdf"],
    ["screens/image.PNG", "/repo/screens/image.PNG", "image/png"],
    ["/tmp/archive.zip", "/tmp/archive.zip", "application/zip"],
    ["/tmp/archive.jar", "/tmp/archive.jar", "application/java-archive"],
    ["/tmp/archive.tar", "/tmp/archive.tar", "application/x-tar"],
    ["/tmp/archive.gz", "/tmp/archive.gz", "application/gzip"],
    ["/tmp/archive.tgz", "/tmp/archive.tgz", "application/gzip"],
    ["/tmp/data.sqlite", "/tmp/data.sqlite", "application/vnd.sqlite3"],
    ["/tmp/data.sqlite3", "/tmp/data.sqlite3", "application/vnd.sqlite3"],
    ["/tmp/data.db", "/tmp/data.db", "application/vnd.sqlite3"],
  ])("offers a host download for %s", (href, path, mimeType) => {
    const target = resolveFileChipTarget(href, "/repo")!;
    expect(fileChipMenu(target).actions).toContainEqual({
      id: "save",
      title: "Save or share",
    });
    expect(fileChipShareSource(target, threadId)).toEqual({
      name: path.split("/").at(-1),
      mimeType,
      resource: { _tag: "media-file", threadId, path },
    });
  });

  it("does not offer downloads the host asset endpoint cannot serve", () => {
    for (const href of ["src/app.ts", "/tmp/archive.7z", "/tmp/clip.mp4.txt"]) {
      const target = resolveFileChipTarget(href, "/repo")!;
      expect(fileChipShareSource(target, threadId)).toBeNull();
      expect(fileChipMenu(target).actions.some(({ id }) => id === "save")).toBe(false);
    }
  });
});
