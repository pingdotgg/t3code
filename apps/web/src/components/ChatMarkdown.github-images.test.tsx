import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: () => ({ _tag: "Success", url: "https://signed.test/workspace-image.svg" }),
}));

vi.mock("./media/MediaActions", () => ({
  MediaActions: ({ children }: { children: ReactNode }) => children,
}));
import { ChatMarkdownAssetImage } from "./ChatMarkdown";

describe("GitHub image fallback", () => {
  it("keeps the loading slot through a proxy failure, then displays the original image", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const url = "https://github.com/user-attachments/assets/433c6edc-fad7-4259-9323-be4b9968488e";
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <ChatMarkdownAssetImage
          environmentId={EnvironmentId.make("env-github")}
          resource={{ _tag: "github-user-attachment", url }}
          alt="Screenshot"
        />,
      );
    });
    try {
      expect(renderer.root.findByType("img").props.src).toBe(
        "https://signed.test/workspace-image.svg",
      );
      await act(async () => renderer.root.findByType("img").props.onError());
      expect(renderer.root.findByType("img").props.src).toBe(url);
      expect(renderer.root.findByProps({ "aria-label": "Loading image" })).toBeDefined();
      await act(async () => renderer.root.findByType("img").props.onLoad());
      expect(renderer.root.findByType("img").props.src).toBe(url);
      expect(renderer.root.findAllByProps({ "aria-label": "Loading image" })).toHaveLength(0);
      await act(async () => renderer.root.findByType("img").props.onError());
      expect(renderer.root.findAllByType("img")).toHaveLength(0);
      expect(renderer.root.findByProps({ role: "alert" })).toBeDefined();
    } finally {
      await act(async () => renderer.unmount());
      vi.unstubAllGlobals();
    }
  });
});
