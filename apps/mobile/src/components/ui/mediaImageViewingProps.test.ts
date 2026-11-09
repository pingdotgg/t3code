import { expect, it } from "vite-plus/test";

import { imageViewingProps } from "./mediaImageViewingProps";
import type { FilePreviewImage, FilePreviewImages } from "./FilePreviewModal.types";

const image = (fields: Omit<FilePreviewImage, "kind"> = {}): FilePreviewImage => ({
  kind: "image",
  ...fields,
});

it("keeps distinct keys and sources for pending versus failed siblings", () => {
  const source: FilePreviewImages = {
    kind: "image",
    selectedIndex: 0,
    images: [image({ uri: "https://signed.test/a.png" }), image(), image({ failed: true })],
  };
  const props = imageViewingProps(source);
  expect(props.keyExtractor(props.images[1], 1)).toBe("pending:1");
  expect(props.keyExtractor(props.images[2], 2)).toBe("failed:2");
  expect(props.images[1]).toEqual({});
  expect(props.images[2]).toMatchObject({ uri: expect.stringMatching(/^data:image\/png;base64,/) });
});

it("reuses the selected image source object when a sibling URI arrives", () => {
  const uriSources = new Map<string, { readonly uri: string }>();
  const pendingSources = new Map<number, Record<string, never>>();
  const before = imageViewingProps(
    {
      kind: "image",
      selectedIndex: 0,
      images: [image({ uri: "https://signed.test/a.png" }), image()],
    },
    uriSources,
    pendingSources,
  );
  const after = imageViewingProps(
    {
      kind: "image",
      selectedIndex: 0,
      images: [
        image({ uri: "https://signed.test/a.png" }),
        image({ uri: "https://signed.test/b.png" }),
      ],
    },
    uriSources,
    pendingSources,
  );
  expect(after.images[0]).toBe(before.images[0]);
  expect(after.keyExtractor(after.images[0], 0)).toBe("https://signed.test/a.png");
});
