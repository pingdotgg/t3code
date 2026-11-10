import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  AssetWorkspaceAssetNotFoundError,
  EnvironmentId,
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
} from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  refreshAssetUrl:
    vi.fn<(environmentId: string, resource: { url: string }) => Promise<string | null>>(),
  alert: vi.fn(),
  previews: [] as unknown[],
  openErrors: [] as (((error: unknown) => void) | undefined)[],
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
  harness.openErrors.push(props.onOpenError);
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
  harness.openErrors.length = 0;
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
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
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
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    if (!progressiveGallery) {
      expect(preview.onRequestClose).not.toHaveBeenCalled();
      expect(harness.alert).toHaveBeenCalledOnce();
      expect(harness.previews).toEqual([]);
      const buttons = harness.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
      await act(async () => buttons.find((button) => button.text === "Cancel")?.onPress?.());
      expect(preview.onRequestClose).toHaveBeenCalledOnce();
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

it("offers try again when the selected image cannot be resolved", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
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
  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(preview.onRequestClose).not.toHaveBeenCalled();
  expect(harness.alert).toHaveBeenCalledOnce();
  const buttons = harness.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
  expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Try again"]);
  await act(async () => buttons.find((button) => button.text === "Cancel")?.onPress?.());
  expect(preview.onRequestClose).toHaveBeenCalledOnce();
});

it("retries a transient asset URL miss before opening", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  let calls = 0;
  harness.refreshAssetUrl.mockImplementation(async () => {
    calls += 1;
    if (calls === 1) return null;
    return "https://signed.test/a.png";
  });
  const selected = image("https://github.com/a.png");
  await using _preview = await openGallery(selected, [selected], true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });

  expect(harness.alert).not.toHaveBeenCalled();
  expect(calls).toBeGreaterThan(1);
  expect(harness.previews.at(-1)).toMatchObject({
    kind: "image",
    images: [{ uri: "https://signed.test/a.png" }],
  });
});

it("offers try again when native open fails after the URL resolves", async () => {
  harness.refreshAssetUrl.mockResolvedValue("https://signed.test/a.png");
  const selected = image("https://github.com/a.png");
  await using preview = await openGallery(selected, [selected], true);

  expect(harness.openErrors.at(-1)).toEqual(expect.any(Function));
  await act(async () => harness.openErrors.at(-1)?.(new Error("download failed")));

  expect(preview.onRequestClose).not.toHaveBeenCalled();
  expect(harness.alert).toHaveBeenCalledOnce();
  const buttons = harness.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
  expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Try again"]);
  await act(async () => buttons.find((button) => button.text === "Try again")?.onPress?.());
  expect(harness.mounts).toBe(2);
});

it("names the checked path when the server cannot find the file", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  const resource = {
    _tag: "media-file" as const,
    threadId: ThreadId.make("thread"),
    path: "v2/extended/duo-color-3-extended-FINAL.png",
  };
  const checkedPath = "/repo/v2/extended/duo-color-3-extended-FINAL.png";
  harness.refreshAssetUrl.mockRejectedValue(
    new AssetWorkspaceAssetNotFoundError({ resource, checkedPath }),
  );
  const selected: FilePreviewItem = { kind: "image", environmentId, resource };
  await using preview = await openGallery(selected, [selected], false);
  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(preview.onRequestClose).not.toHaveBeenCalled();
  expect(harness.alert).toHaveBeenCalledWith(
    "Could not open preview",
    expect.stringContaining(checkedPath),
    expect.any(Array),
  );
  expect(harness.alert.mock.calls[0]?.[1]).not.toMatch(/reconnect/i);
  const buttons = harness.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
  expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Try again"]);
  await act(async () => buttons.find((button) => button.text === "Cancel")?.onPress?.());
  expect(preview.onRequestClose).toHaveBeenCalledOnce();
});
