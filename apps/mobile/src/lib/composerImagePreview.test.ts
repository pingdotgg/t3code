import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  files: new Set<string>(),
  write: vi.fn(async (_content: string, _options: unknown) => undefined),
}));

vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  Directory: class {
    constructor(
      readonly parent: string,
      readonly name: string,
    ) {}
    create() {}
  },
  File: class {
    uri: string;
    constructor(directory: { parent: string; name: string }, name: string) {
      this.uri = `${directory.parent}/${directory.name}/${name}`;
    }
    get exists() {
      return mocks.files.has(this.uri);
    }
    create() {
      mocks.files.add(this.uri);
    }
    delete() {
      mocks.files.delete(this.uri);
    }
    write(content: string, options: unknown) {
      return mocks.write(content, options);
    }
    async move(destination: { uri: string }) {
      if (!mocks.files.delete(this.uri)) throw new Error("source missing");
      mocks.files.add(destination.uri);
      this.uri = destination.uri;
    }
  },
}));

import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

import type { DraftComposerImageAttachment } from "./composerImages";
import { MaterializedPreviewKey, materializedPreviewAtom } from "./composerImagePreview";

describe("materializedPreviewAtom", () => {
  it("keeps the materialized preview when the upload reference lands", async () => {
    const registry = AtomRegistry.make();
    const attachment: DraftComposerImageAttachment = {
      id: "image-1",
      type: "image",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUri: "data:image/png;base64,AAAA",
    };
    const atom = materializedPreviewAtom(new MaterializedPreviewKey(attachment));
    const unmount = registry.mount(atom);
    await vi.waitFor(() => expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true));

    const uploaded = materializedPreviewAtom(
      new MaterializedPreviewKey({
        ...attachment,
        uploadedAttachmentId: "uploaded-1",
        uploadEnvironmentId: "env-1" as EnvironmentId,
      }),
    );

    expect(uploaded).toBe(atom);
    const result = registry.get(uploaded);
    expect(AsyncResult.isSuccess(result) && result.value).toBe(
      "file:///cache/t3-composer-previews/image-1.png",
    );
    expect(mocks.write).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("writes the preview again after a failed write instead of reusing the partial file", async () => {
    const attachment: DraftComposerImageAttachment = {
      id: "image-failed",
      type: "image",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUri: "data:image/png;base64,AAAA",
    };
    const materialize = async () => {
      const registry = AtomRegistry.make();
      const atom = materializedPreviewAtom(new MaterializedPreviewKey(attachment));
      const unmount = registry.mount(atom);
      await vi.waitFor(() => expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true));
      const result = registry.get(atom);
      unmount();
      return AsyncResult.isSuccess(result) ? result.value : undefined;
    };
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.write.mockClear();
    mocks.write.mockRejectedValueOnce(new Error("disk full"));

    expect(await materialize()).toBeNull();
    expect(await materialize()).toBe("file:///cache/t3-composer-previews/image-failed.png");
    expect(mocks.write).toHaveBeenCalledTimes(2);
  });

  it("shares one write when the atom is rebuilt while its preview is still being written", async () => {
    const attachment: DraftComposerImageAttachment = {
      id: "image-rebuilt",
      type: "image",
      name: "pasted.jpeg",
      mimeType: "image/jpeg",
      sizeBytes: 3,
      previewUri: "data:image/jpeg;base64,AAAA",
    };
    const read = () => {
      const registry = AtomRegistry.make();
      const atom = materializedPreviewAtom(new MaterializedPreviewKey(attachment));
      const unmount = registry.mount(atom);
      return vi
        .waitFor(() => {
          const result = registry.get(atom);
          expect(AsyncResult.isSuccess(result)).toBe(true);
          return AsyncResult.isSuccess(result) ? result.value : undefined;
        })
        .finally(unmount);
    };

    expect(await Promise.all([read(), read()])).toEqual([
      "file:///cache/t3-composer-previews/image-rebuilt.jpg",
      "file:///cache/t3-composer-previews/image-rebuilt.jpg",
    ]);
  });
});
