import { act, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  AssetWorkspaceAssetNotFoundError,
  AuthFilesystemReadScope,
  EnvironmentId,
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { requireNativeModule } from "expo";
import type {
  AttachmentPreviewFile,
  downloadAttachmentForPreview,
} from "../../lib/attachmentDownload";
import type { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import type { useMediaActions } from "../../state/mediaActions";

const harness = vi.hoisted(() => ({
  refreshAssetUrl:
    vi.fn<(environmentId: string, resource: { url: string }) => Promise<string | null>>(),
  alert: vi.fn(),
  share: vi.fn<typeof downloadAndShareAttachment>(),
  download: vi.fn<typeof downloadAttachmentForPreview>(),
  previews: [] as unknown[],
  mounts: 0,
  presentationFinished: false,
}));

vi.mock("../../state/assets", () => ({
  refreshAssetUrl: harness.refreshAssetUrl,
  useRefreshAssetUrl: (environmentId: string, resource: { url: string }) => () =>
    harness.refreshAssetUrl(environmentId, resource),
}));
vi.mock("../../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../../lib/attachmentDownload", () => ({
  downloadAndShareAttachment: harness.share,
  downloadAttachmentForPreview: harness.download,
  nativeViewerErrorMessage: () => "",
  shareLocalAttachment: vi.fn(),
}));
vi.mock("../../lib/previewPresentation", () => ({ usePreviewPresentation: () => {} }));
vi.mock("./Dialog", () => ({ alert: harness.alert }));
vi.mock("./Button", () => ({ Button: () => null }));
vi.mock("./SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("./AppText", () => ({ AppText: () => null }));
vi.mock("../PdfPreview", () => ({ PdfPreview: () => null }));
vi.mock("../MediaPreviewHeader", () => ({
  MediaPreviewHeader: ({ media }: { media: ReturnType<typeof useMediaActions> }) =>
    media.actions
      .filter(({ id }) => id === "save" || id === "save-image")
      .map(({ id, disabled, run, title }) => (
        <button
          key={id}
          data-action={id === "save" ? "share" : id}
          disabled={disabled}
          onClick={run}
        >
          {title}
        </button>
      )),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: (environmentId: string) => environmentId },
}));
const grant = { authenticated: true, scopes: [AuthFilesystemReadScope] };
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: grant, error: null }),
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => AsyncResult.success(grant) },
}));
vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-haptics", () => ({ notificationAsync: vi.fn() }));
vi.mock("react-native", () => ({
  Modal: () => null,
  Platform: { OS: "android", Version: 35 },
  View: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("react-native-image-viewing", () => ({
  default: function ImageViewing(props: {
    images: readonly { uri?: string }[];
    imageIndex: number;
    HeaderComponent?: ComponentType<{ imageIndex: number }>;
  }) {
    useState(() => harness.mounts++);
    harness.previews.push({
      kind: "image",
      images: props.images,
      selectedIndex: props.imageIndex,
    });
    const [index, setIndex] = useState(props.imageIndex);
    const Header = props.HeaderComponent;
    if (!Header) return null;
    return (
      <>
        <Header imageIndex={index} />
        {props.images.map(({ uri }, imageIndex) => (
          <button key={uri} data-page={imageIndex} onClick={() => setIndex(imageIndex)} />
        ))}
      </>
    );
  },
}));

import { FilePreviewModal as AndroidFilePreviewModal } from "./FilePreviewModal.android";
import type { FilePreviewItem, FilePreviewViewerProps } from "./FilePreviewModal.types";
import { FilePreviewSession } from "./FilePreviewSession";

function Viewer(props: FilePreviewViewerProps) {
  useState(() => harness.mounts++);
  harness.previews.push(props.source);
  const { onPresent } = props;
  // Stands in for the native presentation starting.
  useEffect(() => onPresent?.(() => harness.presentationFinished), [onPresent]);
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
  const container = document.createElement("div");
  const root = createRoot(container);
  const onRequestClose = vi.fn();
  const source = { ...selected, gallery };
  await act(async () =>
    root.render(
      progressiveGallery ? (
        <FilePreviewSession
          source={source}
          onRequestClose={onRequestClose}
          progressiveGallery
          Viewer={Viewer}
        />
      ) : (
        <AndroidFilePreviewModal source={source} onRequestClose={onRequestClose} />
      ),
    ),
  );
  return {
    container,
    onRequestClose,
    [Symbol.asyncDispose]: () => act(async () => root.unmount()),
  };
}

it.each(["completes", "fails"] as const)(
  "isolates Android gallery shares when the previous download %s after a swipe",
  async (outcome) => {
    const threadId = ThreadId.make("thread");
    const workspaceImage = (folder: string): FilePreviewItem => {
      const path = `${folder}/image.png`;
      const resource = { _tag: "media-file" as const, threadId, path };
      return {
        kind: "image",
        environmentId,
        resource,
        name: "image.png",
        actionsSource: { environmentId, resource, name: "image.png", mimeType: "image/png" },
      };
    };
    const first = workspaceImage("first");
    const second = workspaceImage("second");
    harness.refreshAssetUrl.mockImplementation(
      async (_environmentId, resource) =>
        "https://assets.test/" + ("path" in resource ? resource.path : resource.url),
    );
    const pendingFirst = Promise.withResolvers<void>();
    const pendingSecond = Promise.withResolvers<void>();
    harness.share
      .mockReset()
      .mockReturnValueOnce(pendingFirst.promise)
      .mockReturnValueOnce(pendingSecond.promise);
    await using preview = await openGallery(first, [first, second], false);
    const share = () => preview.container.querySelector<HTMLButtonElement>("[data-action=share]")!;

    await act(async () => share().click());
    expect(share().textContent).toBe("Opening share sheet…");
    const firstRequest = harness.share.mock.calls[0]![0];

    await act(async () =>
      preview.container.querySelector<HTMLButtonElement>("[data-page='1']")!.click(),
    );
    expect(share().textContent).toBe("Share");
    expect(share().disabled).toBe(false);
    expect(firstRequest.signal.aborted).toBe(true);

    await act(async () => share().click());
    expect(harness.share.mock.calls[1]?.[0].url).toBe("https://assets.test/second/image.png");
    await act(async () => {
      if (outcome === "fails") pendingFirst.reject(new Error("Download failed"));
      else pendingFirst.resolve();
    });
    expect(harness.alert).not.toHaveBeenCalled();
    expect(share().textContent).toBe("Opening share sheet…");

    await act(async () => pendingSecond.resolve());
    expect(share().disabled).toBe(false);
  },
);

it("hands the previous Android gallery image to the photo library after a swipe", async () => {
  const remoteImage = (name: string): FilePreviewItem => {
    const uri = `https://assets.test/${name}`;
    return { ...image(uri), name, actionsSource: { uri, name, mimeType: "image/png" } };
  };
  const first = remoteImage("first.png");
  const second = remoteImage("second.png");
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => resource.url);
  const pending = Promise.withResolvers<AttachmentPreviewFile>();
  harness.download.mockReset().mockReturnValueOnce(pending.promise);
  const saveImageToLibrary = vi.fn().mockRejectedValue(new Error("Library full"));
  vi.mocked(requireNativeModule).mockReturnValueOnce({ saveImageToLibrary });
  await using preview = await openGallery(first, [first, second], false);

  await act(async () =>
    preview.container.querySelector<HTMLButtonElement>("[data-action=save-image]")!.click(),
  );
  expect(harness.download).toHaveBeenCalledWith(
    expect.objectContaining({ url: "https://assets.test/first.png" }),
  );
  await act(async () =>
    preview.container.querySelector<HTMLButtonElement>("[data-page='1']")!.click(),
  );
  expect(preview.container.querySelector<HTMLButtonElement>("[data-action=share]")!.disabled).toBe(
    false,
  );
  const uri = "file:///cache/first.png";
  await act(async () => pending.resolve({ uri, share: vi.fn(), dispose: vi.fn() }));

  expect(saveImageToLibrary).toHaveBeenCalledWith(uri, "image/png", "first.png");
  expect(harness.alert).toHaveBeenCalledWith("Could not save image", "Library full");
});

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

it.each([
  // The progressive viewer already gave the missing image a page; a viewer that waits opens without it.
  [
    true,
    1,
    [{ failed: true }, { uri: "https://signed.test/a.png" }, { uri: "https://signed.test/c.png" }],
  ],
  [false, 0, [{ uri: "https://signed.test/a.png" }, { uri: "https://signed.test/c.png" }]],
])(
  "opens the gallery when a sibling cannot be resolved (progressive: %s)",
  async (progressiveGallery, selectedIndex, images) => {
    harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
      if (resource.url.endsWith("missing.png")) throw new Error("not found");
      return `https://signed.test/${resource.url.split("/").pop()}`;
    });
    const selected = image("https://github.com/a.png");
    await using preview = await openGallery(
      selected,
      [image("https://github.com/missing.png"), selected, image("https://github.com/c.png")],
      progressiveGallery,
    );

    expect(preview.onRequestClose).not.toHaveBeenCalled();
    expect(harness.alert).not.toHaveBeenCalled();
    expect(harness.previews.at(-1)).toEqual({
      kind: "image",
      selectedIndex,
      images: images.map((page) => expect.objectContaining(page)),
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

it("names the checked path when the server cannot find the file", async () => {
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

  expect(preview.onRequestClose).toHaveBeenCalledOnce();
  expect(harness.alert).toHaveBeenCalledWith(
    "Could not open preview",
    expect.stringContaining(checkedPath),
  );
  expect(harness.alert.mock.calls[0]?.[1]).not.toMatch(/reconnect/i);
});

it.each([
  // Handed to native but not yet started there, or still on screen.
  ["image", false, 1],
  ["image", true, 2],
  // A PDF is still resolving here, so its viewer never presented and a re-render must not restart it.
  ["pdf", true, 1],
] as const)(
  "a re-tap of the open %s restarts the preview only once its native viewer closed (closed: %s)",
  async (kind, finished, starts) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    harness.presentationFinished = finished;
    harness.mounts = 0;
    harness.refreshAssetUrl.mockReset();
    if (kind === "image") harness.refreshAssetUrl.mockResolvedValue("https://signed.test/a.png");
    else harness.refreshAssetUrl.mockReturnValue(new Promise(() => {}));
    const selected: FilePreviewItem = { ...image("https://github.com/a.png"), kind };
    const root = createRoot(document.createElement("div"));
    await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
    const render = () =>
      act(async () =>
        root.render(
          <FilePreviewSession
            source={{ ...selected, gallery: [selected] }}
            onRequestClose={() => {}}
            progressiveGallery
            Viewer={Viewer}
          />,
        ),
      );
    await render();
    await render();
    expect(harness.refreshAssetUrl).toHaveBeenCalledTimes(starts);
  },
);

it("does not carry a presented viewer over to a different item that is still resolving", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.presentationFinished = true;
  harness.refreshAssetUrl.mockReset();
  harness.refreshAssetUrl.mockImplementation((_environmentId, resource) =>
    resource.url.endsWith("a.png")
      ? Promise.resolve("https://signed.test/a.png")
      : new Promise(() => {}),
  );
  const shown = image("https://github.com/a.png");
  const resolving: FilePreviewItem = { ...image("https://github.com/b.pdf"), kind: "pdf" };
  const root = createRoot(document.createElement("div"));
  await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
  const render = (item: FilePreviewItem) =>
    act(async () =>
      root.render(
        <FilePreviewSession
          source={{ ...item, gallery: [item] }}
          onRequestClose={() => {}}
          progressiveGallery
          Viewer={Viewer}
        />,
      ),
    );
  await render(shown);
  await render(resolving);
  await render(resolving);
  expect(
    harness.refreshAssetUrl.mock.calls.filter(([, r]) => r.url.endsWith("b.pdf")),
  ).toHaveLength(1);
});
