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
const thread = vi.hoisted(() => ({ focused: true }));

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

vi.mock("@react-navigation/native", () => ({ useIsFocused: () => thread.focused }));
vi.mock("../../state/threads", () => ({ environmentThreadDetails: {} }));

import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";
import { WorkspaceMutationIdProvider } from "./WorkspaceMutationIdProvider";

const source: MediaVideoPreviewSource = {
  type: "media",
  name: "Clip",
  mimeType: "video/mp4",
  environmentId: EnvironmentId.make("environment"),
  resource: { _tag: "media-file", threadId: ThreadId.make("thread"), path: "./clip.mp4" },
};

it("reuses the poster when an embed is recycled in the same visit and checks again on return", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  using _cleanup = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const render = (showVideo = true) => {
    act(() =>
      root.render(
        <WorkspaceMutationIdProvider threadRef={null}>
          {showVideo ? <ThreadMarkdownVideo source={source} thumbnailVisible /> : null}
        </WorkspaceMutationIdProvider>,
      ),
    );
    return host.posterKeys.at(-1);
  };

  const original = render();
  render(false);
  host.fileRevision = "blue";
  expect(render()).toBe(original);

  thread.focused = false;
  expect(render()).toBe(original);
  thread.focused = true;
  expect(render()).not.toBe(original);
});
