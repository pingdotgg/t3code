import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, SOURCE_CONTROL_MEDIA_ASSET } from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  refreshAssetUrl: vi.fn<(environmentId: string, resource: { url: string }) => Promise<string>>(),
  alert: vi.fn(),
  previews: [] as unknown[],
  mounts: 0,
}));

vi.mock("../../state/assets", () => ({ refreshAssetUrl: harness.refreshAssetUrl }));
vi.mock("../../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../../lib/attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  nativeViewerErrorMessage: () => "",
  shareLocalAttachment: vi.fn(),
}));
vi.mock("../../lib/previewPresentation", () => ({ usePreviewPresentation: () => {} }));
vi.mock("./Dialog", () => ({ alert: harness.alert }));

import type { FilePreviewItem, FilePreviewViewerProps } from "./FilePreviewModal.types";
import { FilePreviewSession } from "./FilePreviewSession";

function Viewer(props: FilePreviewViewerProps) {
  useState(() => harness.mounts++);
  harness.previews.push(props.source);
  return null;
}

const environmentId = EnvironmentId.make("environment");
const image = (url: string): FilePreviewItem => ({
  kind: "image",
  environmentId,
  resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
});

async function openGallery(
  selected: FilePreviewItem,
  gallery: readonly FilePreviewItem[],
  progressiveGallery: boolean,
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.previews.length = 0;
  harness.mounts = 0;
  harness.alert.mockClear();
  const root = createRoot(document.createElement("div"));
  const onRequestClose = vi.fn();
  await act(async () =>
    root.render(
      <FilePreviewSession
        source={{ ...selected, gallery }}
        onRequestClose={onRequestClose}
        progressiveGallery={progressiveGallery}
        Viewer={Viewer}
      />,
    ),
  );
  return { onRequestClose, [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
}

it.each([true, false])(
  "keeps the gallery stable while a sibling is still resolving (progressive: %s)",
  async (progressiveGallery) => {
    const slow = Promise.withResolvers<string>();
    harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) =>
      resource.url.endsWith("slow.png") ? slow.promise : "https://signed.test/a.png",
    );
    const selected = image("https://github.com/a.png");
    await using _preview = await openGallery(
      selected,
      [image("https://github.com/slow.png"), selected],
      progressiveGallery,
    );

    if (progressiveGallery) {
      expect(harness.previews.at(-1)).toMatchObject({
        kind: "image",
        selectedIndex: 1,
        images: [
          expect.not.objectContaining({ uri: expect.anything() }),
          { uri: "https://signed.test/a.png" },
        ],
      });
    } else {
      expect(harness.previews).toEqual([]);
    }
    await act(async () => slow.resolve("https://signed.test/slow.png"));
    expect(harness.previews.at(-1)).toMatchObject({
      selectedIndex: 1,
      images: [{ uri: "https://signed.test/slow.png" }, { uri: "https://signed.test/a.png" }],
    });
    expect(harness.mounts).toBe(1);
  },
);

it.each([true, false])(
  "handles a failed sibling without leaving a pending page (progressive: %s)",
  async (progressiveGallery) => {
    harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
      if (resource.url.endsWith("missing.png")) throw new Error("not found");
      return `https://signed.test/${resource.url.split("/").pop()}`;
    });
    const selected = image("https://github.com/a.png");
    await using preview = await openGallery(
      selected,
      [selected, image("https://github.com/missing.png"), image("https://github.com/c.png")],
      progressiveGallery,
    );

    if (!progressiveGallery) {
      expect(preview.onRequestClose).toHaveBeenCalledOnce();
      expect(harness.alert).toHaveBeenCalledOnce();
      expect(harness.previews).toEqual([]);
      return;
    }

    expect(preview.onRequestClose).not.toHaveBeenCalled();
    expect(harness.alert).not.toHaveBeenCalled();
    expect(harness.previews.at(-1)).toMatchObject({
      selectedIndex: 0,
      images: [
        { uri: "https://signed.test/a.png" },
        { failed: true },
        { uri: "https://signed.test/c.png" },
      ],
    });
  },
);

it("closes the preview when the selected image cannot be resolved", async () => {
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
    if (resource.url.endsWith("missing.png")) throw new Error("not found");
    return `https://signed.test/${resource.url.split("/").pop()}`;
  });
  const selected = image("https://github.com/missing.png");
  await using preview = await openGallery(
    selected,
    [image("https://github.com/a.png"), selected],
    true,
  );

  expect(preview.onRequestClose).toHaveBeenCalledOnce();
  expect(harness.alert).toHaveBeenCalledOnce();
});
