import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { MediaVideoPreviewSource } from "../../lib/videoPreviewSource";

const host = vi.hoisted(() => ({
  fileRevision: "red",
  minted: null as { readonly revision: string | null | undefined; fileRevision: string } | null,
  posterKeys: [] as string[],
}));

// Like the app's URL cache: a reader reuses the last mint unless it reads a new revision.
vi.mock("../../state/assets", () => ({
  useAssetUrlState: (_environmentId: unknown, _resource: unknown, revision?: string | null) => {
    if (host.minted === null || (revision !== undefined && revision !== host.minted.revision)) {
      host.minted = { revision, fileRevision: host.fileRevision };
    }
    return {
      _tag: "Success",
      url: "https://host.example/api/assets/clip.mp4",
      expiresAt: Number.MAX_SAFE_INTEGER,
      fileRevision: host.minted.fileRevision,
    };
  },
  useRefreshAssetUrl: () => async () => null,
}));
vi.mock("../../components/MediaVideoPlayer", () => ({
  MediaVideoPlayer: (props: { readonly thumbnailKey: string }) => {
    host.posterKeys.push(props.thumbnailKey);
    return null;
  },
}));

import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";

const source: MediaVideoPreviewSource = {
  type: "media",
  name: "Clip",
  mimeType: "video/mp4",
  environmentId: EnvironmentId.make("environment"),
  resource: { _tag: "media-file", threadId: ThreadId.make("thread"), path: "./clip.mp4" },
};

it("gives a workspace video replaced while its thread was closed a new poster", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const openThread = () => {
    act(() => root.render(<ThreadMarkdownVideo source={source} thumbnailVisible />));
    return host.posterKeys.at(-1);
  };
  const leaveThread = () => act(() => root.render(null));

  const red = openThread();
  leaveThread();
  expect(openThread()).toBe(red);
  leaveThread();
  host.fileRevision = "blue";
  expect(openThread()).not.toBe(red);
  act(() => root.unmount());
});
