import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, SOURCE_CONTROL_MEDIA_ASSET } from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  refreshAssetUrl: vi.fn<(environmentId: string, resource: { url: string }) => Promise<string>>(),
  alert: vi.fn(),
  previews: [] as { uri: string; gallery?: readonly { uri: string }[] }[],
}));

vi.mock("../state/assets", () => ({ refreshAssetUrl: harness.refreshAssetUrl }));
vi.mock("../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../lib/attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  nativeViewerErrorMessage: () => "",
  shareLocalAttachment: vi.fn(),
}));
vi.mock("../lib/previewPresentation", () => ({ usePreviewPresentation: () => {} }));
vi.mock("./ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("./FilePreview", () => ({
  FilePreview: (props: { source: { uri: string; gallery?: readonly { uri: string }[] } }) => {
    harness.previews.push(props.source);
    return null;
  },
}));

import type { FilePreviewItem } from "./FilePreviewModal.types";
import { FilePreviewModal } from "./FilePreviewModal";

const environmentId = EnvironmentId.make("environment");
const image = (url: string): FilePreviewItem => ({
  kind: "image",
  environmentId,
  resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
});

async function openGallery(selected: FilePreviewItem, gallery: readonly FilePreviewItem[]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.previews.length = 0;
  harness.alert.mockClear();
  const root = createRoot(document.createElement("div"));
  const onRequestClose = vi.fn();
  await act(async () =>
    root.render(
      <FilePreviewModal source={{ ...selected, gallery }} onRequestClose={onRequestClose} />,
    ),
  );
  return { onRequestClose, [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
}

it("opens the selected image when a gallery sibling cannot be resolved", async () => {
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
    if (resource.url.endsWith("missing.png")) throw new Error("not found");
    return `https://signed.test/${resource.url.split("/").pop()}`;
  });
  const selected = image("https://github.com/a.png");
  await using preview = await openGallery(selected, [
    selected,
    image("https://github.com/missing.png"),
    image("https://github.com/c.png"),
  ]);

  expect(preview.onRequestClose).not.toHaveBeenCalled();
  expect(harness.alert).not.toHaveBeenCalled();
  expect(harness.previews.at(-1)).toMatchObject({
    uri: "https://signed.test/a.png",
    gallery: [{ uri: "https://signed.test/a.png" }, { uri: "https://signed.test/c.png" }],
  });
});

it("closes the preview when the selected image cannot be resolved", async () => {
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
    if (resource.url.endsWith("missing.png")) throw new Error("not found");
    return `https://signed.test/${resource.url.split("/").pop()}`;
  });
  const selected = image("https://github.com/missing.png");
  await using preview = await openGallery(selected, [image("https://github.com/a.png"), selected]);

  expect(preview.onRequestClose).toHaveBeenCalledOnce();
  expect(harness.alert).toHaveBeenCalledOnce();
  expect(harness.previews).toEqual([]);
});
