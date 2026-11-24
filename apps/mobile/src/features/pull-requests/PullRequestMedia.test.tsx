import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { FilePreviewSource } from "../../components/ui/FilePreviewModal.types";
import type { VideoPreviewSource } from "../../components/ui/VideoPreviewModal";
import type { MarkdownImageRenderer } from "../../native/SelectableMarkdownText";

const harness = vi.hoisted(() => ({
  imageOnLoad: null as (() => void) | null,
  imageOnError: null as (() => void) | null,
  presentationSources: [] as { identifier: string; fallbackIdentifier?: string }[],
  previewSource: null as FilePreviewSource | null,
  videoSource: null as VideoPreviewSource | null,
  markdownProps: [] as {
    markdown: string;
    renderImage?: MarkdownImageRenderer;
    onImagePress?: (href: string) => void;
  }[],
  videoPlayers: [] as { uri: string | null; name: string }[],
  threadImages: [] as {
    sourceKey: string;
    sourceIdentifier?: string;
    onPressPreview: (source: FilePreviewSource) => void;
  }[],
}));

vi.mock("react-native", () => ({
  Pressable: (props: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button type="button" aria-label={props.accessibilityLabel} onClick={() => props.onPress?.()}>
      {props.children}
    </button>
  ),
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-image", () => ({
  Image: (props: { onLoad?: () => void; onError?: () => void }) => {
    harness.imageOnLoad = props.onLoad ?? null;
    harness.imageOnError = props.onError ?? null;
    return <img alt="" />;
  },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/NativePresentation", () => ({
  PresentationSource: (props: {
    identifier: string;
    fallbackIdentifier?: string;
    children?: ReactNode;
  }) => {
    harness.presentationSources.push({
      identifier: props.identifier,
      ...(props.fallbackIdentifier !== undefined
        ? { fallbackIdentifier: props.fallbackIdentifier }
        : {}),
    });
    return <div>{props.children}</div>;
  },
}));
vi.mock("../../components/ui/FilePreviewModal", () => ({
  FilePreviewModal: (props: { source: FilePreviewSource | null }) => {
    harness.previewSource = props.source;
    return null;
  },
}));
vi.mock("../../components/ui/VideoPreviewModal", () => ({
  VideoPreviewModal: (props: { source: VideoPreviewSource | null }) => {
    harness.videoSource = props.source;
    return null;
  },
}));
vi.mock("../../components/MediaVideoPlayer", () => ({
  MediaVideoPlayer: (props: { uri: string | null; name: string }) => {
    harness.videoPlayers.push({ uri: props.uri, name: props.name });
    return <div data-video={props.name} />;
  },
}));
vi.mock("../../components/VideoAttachmentTile", () => ({
  VideoAttachmentTile: () => null,
}));
vi.mock("../threads/ThreadMarkdownImage", () => ({
  ThreadMarkdownImageView: (props: {
    sourceKey: string;
    sourceIdentifier?: string;
    onPressPreview: (source: FilePreviewSource) => void;
  }) => {
    harness.threadImages.push(props);
    return (
      <button
        type="button"
        data-image={props.sourceKey}
        onClick={() =>
          props.onPressPreview({
            kind: "image",
            uri: props.sourceKey,
            sourceIdentifier: `local:${props.sourceKey}`,
          })
        }
      />
    );
  },
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Idle" }),
  useRefreshAssetUrl: () => async () => null,
}));
vi.mock("../../state/entities", () => ({
  useProject: () => null,
}));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: () => ({ environmentId: "env", input: {} }),
}));
vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));
vi.mock("../../native/useOpenPullRequest", () => ({
  useOpenPullRequest: () => async () => {},
}));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: {
    markdown: string;
    renderImage?: MarkdownImageRenderer;
    onImagePress?: (href: string) => void;
  }) => {
    harness.markdownProps.push(props);
    return (
      <div>
        {props.renderImage?.({
          href: "https://drop.example.com/demo.mp4",
          alt: "Recording",
          title: null,
        })}
        {props.renderImage?.({
          href: "https://drop.example.com/first.png",
          alt: "First",
          title: null,
        })}
      </div>
    );
  },
}));

import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestImageAttachment } from "./PullRequestMedia";
import {
  pullRequestImageSource,
  pullRequestScopedSourceIdentifier,
} from "./pullRequestMediaSource";

function resetHarness() {
  harness.imageOnLoad = null;
  harness.imageOnError = null;
  harness.presentationSources.length = 0;
  harness.previewSource = null;
  harness.videoSource = null;
  harness.markdownProps.length = 0;
  harness.videoPlayers.length = 0;
  harness.threadImages.length = 0;
}

it("registers PullRequestImageAttachment as a presentation source only after the image loads", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetHarness();
  const first = pullRequestImageSource("https://drop.example.com/a.png", null);
  const second = pullRequestImageSource("https://drop.example.com/b.png", null);
  const source = {
    ...first,
    name: "Before",
    sourceIdentifier: pullRequestScopedSourceIdentifier("pr-attachment:1", first),
  };
  const gallery = [
    source,
    {
      ...second,
      name: "After",
      sourceIdentifier: pullRequestScopedSourceIdentifier("pr-attachment:1", second),
    },
  ];
  const container = document.createElement("div");
  const root = createRoot(container);
  await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };

  await act(async () =>
    root.render(
      <PullRequestImageAttachment
        url="https://drop.example.com/a.png"
        caption="Before"
        source={source}
        gallery={gallery}
      />,
    ),
  );
  expect(harness.presentationSources.at(-1)).toEqual({
    identifier: "",
    fallbackIdentifier: "",
  });

  await act(async () => harness.imageOnLoad?.());
  const registered = harness.presentationSources.at(-1)!;
  expect(registered.identifier).not.toBe("");
  expect(registered.fallbackIdentifier).toBe(source.sourceIdentifier);

  await act(async () => container.querySelector("button")!.click());
  expect(harness.previewSource).toMatchObject({
    name: "Before",
    sourceIdentifier: registered.identifier,
    gallery,
  });

  await act(async () => harness.imageOnError?.());
  expect(harness.presentationSources.at(-1)).toEqual({
    identifier: "",
    fallbackIdentifier: "",
  });
});

it("wires bare image attachments, markdown videos, and onImagePress guards in PullRequestMarkdown", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetHarness();
  const body = [
    "![First](https://drop.example.com/first.png)",
    "",
    "https://drop.example.com/bare.png",
  ].join("\n");
  const container = document.createElement("div");
  const root = createRoot(container);
  await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };

  await act(async () => root.render(<PullRequestMarkdown markdown={body} />));

  // Markdown-embedded .mp4 renders through MediaVideoPlayer instead of ThreadMarkdownImageView.
  expect(harness.videoPlayers).toContainEqual({
    uri: "https://drop.example.com/demo.mp4",
    name: "Recording",
  });

  // Bare image attachment shares the same scoped gallery as inline markdown images.
  const bareButton = container.querySelector<HTMLButtonElement>(
    'button[data-image="https://drop.example.com/bare.png"]',
  )!;
  await act(async () => bareButton.click());
  expect(harness.previewSource?.gallery?.map((item) => item.name)).toEqual(["First", "bare.png"]);
  expect(harness.previewSource?.gallery?.[0]?.sourceIdentifier).toBe(
    harness.threadImages.find((img) => img.sourceKey === "https://drop.example.com/first.png")
      ?.sourceIdentifier,
  );

  // onImagePress ignores non-HTTP and malformed URLs, clears sourceIdentifier for matched items, and routes video URLs to VideoPreviewModal.
  const onImagePress = harness.markdownProps[0]?.onImagePress;
  harness.previewSource = null;
  await act(async () => onImagePress?.("screenshots/local.png"));
  await act(async () => onImagePress?.("http://:80/clip.mp4"));
  expect(harness.previewSource).toBeNull();
  expect(harness.videoSource).toBeNull();

  await act(async () => onImagePress?.("https://drop.example.com/first.png"));
  expect(harness.previewSource).toMatchObject({
    name: "First",
    sourceIdentifier: "",
  });

  harness.previewSource = null;
  await act(async () => onImagePress?.("https://drop.example.com/demo.mp4"));
  expect(harness.previewSource).toBeNull();
  expect(harness.videoSource).toMatchObject({
    type: "media",
    uri: "https://drop.example.com/demo.mp4",
    mimeType: "video/mp4",
  });
});
