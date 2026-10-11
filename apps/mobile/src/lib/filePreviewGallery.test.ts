import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import type { FilePreviewItem } from "../components/FilePreviewModal.types";
import { filePreviewGallery, filePreviewKey, filePreviewName } from "./filePreviewGallery";

const first: FilePreviewItem = { kind: "image", uri: "https://example.com/first.png" };
const second: FilePreviewItem = { kind: "image", uri: "https://example.com/second.png" };

describe("image preview groups", () => {
  it("preserves ordering, removes duplicates and retains the tapped transition source", () => {
    const selected = { ...second, sourceIdentifier: "thumbnail-2" };
    expect(filePreviewGallery(selected, [first, second, first])).toEqual([first, selected]);
  });

  it("keeps documents out of image groups and preserves a standalone image", () => {
    const document: FilePreviewItem = { kind: "pdf", uri: "file:///report.pdf" };
    expect(filePreviewGallery(first, [document])).toEqual([first]);
    expect(filePreviewGallery(document, [first, second])).toEqual([document]);
  });

  it("matches remote originals despite metadata and property order differences", () => {
    const environmentId = EnvironmentId.make("test");
    const a: FilePreviewItem = {
      kind: "image",
      environmentId,
      resource: { _tag: "attachment", attachmentId: "a", fileName: "old.png" },
    };
    const b: FilePreviewItem = {
      kind: "image",
      environmentId,
      resource: {
        attachmentId: "a",
        _tag: "attachment",
        fileName: "new.png",
        mimeType: "image/png",
      },
    };
    expect(filePreviewKey(a)).toBe(filePreviewKey(b));
    expect(filePreviewGallery(b, [a])).toEqual([b]);
  });

  it("uses actual filenames instead of captions with punctuation and paths", () => {
    expect(
      filePreviewName({ ...first, name: 'main: "New thread in..." shows pingdotgg/t3code' }),
    ).toBe("first.png");
    expect(
      filePreviewName({
        kind: "image",
        uri: "https://example.com/image",
        name: "test: before... / after",
      }),
    ).toBe("test_ before___ _ after");
    expect(
      filePreviewName({ kind: "document", uri: "file:///tmp/report.docx", name: "report.docx" }),
    ).toBe("report.docx");
  });
});
