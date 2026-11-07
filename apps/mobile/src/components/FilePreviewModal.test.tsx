import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, SOURCE_CONTROL_MEDIA_ASSET } from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  refreshAssetUrl: vi.fn<(environmentId: string, resource: { url: string }) => Promise<string>>(),
  alert: vi.fn(),
  previews: [] as unknown[],
  mounts: 0,
  platform: { OS: process.env.T3_MOBILE_TEST_PLATFORM === "android" ? "android" : "ios" },
}));

vi.mock("react-native", () => ({ Platform: harness.platform }));
vi.mock("../state/assets", () => ({ refreshAssetUrl: harness.refreshAssetUrl }));
vi.mock("../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../lib/attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  nativeViewerErrorMessage: () => "",
  shareLocalAttachment: vi.fn(),
}));
vi.mock("../lib/previewPresentation", () => ({ usePreviewPresentation: () => {} }));
vi.mock("./ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("./FilePreview", async () => {
  const { useState } = await import("react");
  return {
    FilePreview: (props: { source: unknown }) => {
      useState(() => harness.mounts++);
      harness.previews.push(props.source);
      return null;
    },
  };
});

import type { FilePreviewItem } from "./FilePreviewModal.types";
import { FilePreviewModal } from "./FilePreviewModal";

const environmentId = EnvironmentId.make("environment");
const image = (url: string): FilePreviewItem => ({
  kind: "image",
  environmentId,
  resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
});

async function openGallery(
  selected: FilePreviewItem,
  gallery: readonly FilePreviewItem[],
  platform = harness.platform.OS,
) {
  harness.platform.OS = platform;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.previews.length = 0;
  harness.mounts = 0;
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

it("keeps the gallery stable while a sibling is still resolving", async () => {
  const platform = harness.platform.OS;
  const slow = Promise.withResolvers<string>();
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) =>
    resource.url.endsWith("slow.png") ? slow.promise : "https://signed.test/a.png",
  );
  const selected = image("https://github.com/a.png");
  await using _preview = await openGallery(
    selected,
    [image("https://github.com/slow.png"), selected],
    platform,
  );

  if (platform === "ios") {
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
});

it("handles a failed sibling without leaving a pending page", async () => {
  const platform = harness.platform.OS;
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
    if (resource.url.endsWith("missing.png")) throw new Error("not found");
    return `https://signed.test/${resource.url.split("/").pop()}`;
  });
  const selected = image("https://github.com/a.png");
  await using preview = await openGallery(
    selected,
    [selected, image("https://github.com/missing.png"), image("https://github.com/c.png")],
    platform,
  );

  if (platform === "android") {
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
});
