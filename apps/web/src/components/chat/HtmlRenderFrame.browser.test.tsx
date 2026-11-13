import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

vi.mock(import("~/assets/longLivedAssetUrls"), () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: "about:blank",
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));
vi.mock(import("~/assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrlRefresh: () => async () => "about:blank",
}));

import { HtmlRenderFrame } from "./HtmlRenderFrame";

describe("HtmlRenderFrame", () => {
  it("reports leaving full screen when it unmounts while expanded", async () => {
    const onFullscreenChange = vi.fn();
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
        onFullscreenChange={onFullscreenChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(true);

    await screen.unmount();
    expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
  });

  it("shows the inline page full screen instead of loading a second copy", async () => {
    const onFullscreenChange = vi.fn();
    await using screen = await render(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "attachment", title: "Report", height: 200 }}
        threadRef={undefined}
        onFullscreenChange={onFullscreenChange}
      />,
    );
    const inlinePage = document.querySelector('iframe[title="Report"]');
    expect(inlinePage).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Open full screen" }));
    await vi.waitFor(() => expect(onFullscreenChange).toHaveBeenLastCalledWith(true));

    // A second document would start from scratch and drop what the reader did in the first.
    expect(document.querySelectorAll('iframe[title="Report"]')).toHaveLength(1);
    expect(document.querySelector('iframe[title="Report"]')).toBe(inlinePage);
  });
});
