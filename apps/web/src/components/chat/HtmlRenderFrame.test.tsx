// @vitest-environment jsdom

import { EnvironmentId } from "@t3tools/contracts";
import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { HtmlRenderFrame } from "./HtmlRenderFrame";

const assets = vi.hoisted(() => ({
  cached: { _tag: "Success" as const, url: "", expiresAt: 0 },
  refresh: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => assets.cached,
  useAssetUrlRefresh: () => assets.refresh,
}));
vi.mock("../files/BrowserDocumentFrame", () => ({
  HtmlRenderDocument: (props: { src: string }) => <div data-page-url={props.src} />,
}));

function Thread() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <HtmlRenderFrame
      environmentId={EnvironmentId.make("test-environment")}
      htmlRender={{ attachmentId: "render-chart.html", title: "Quarterly chart", height: 320 }}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      onOpen={() => {}}
    />
  );
}

describe("minimized HTML render", () => {
  const click = { nativeEvent: new Event("click") };
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Date, "now").mockReturnValue(0);
    // One minute of life left: too little to hand a frame that cannot report a failed load.
    assets.cached = { _tag: "Success", url: "https://environment.test/cached", expiresAt: 60_000 };
    assets.refresh.mockReset();
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Minimize reports the page as expanded; the title row that replaces it, as collapsed.
  const press = (control: "minimize" | "title row") =>
    act(async () => {
      renderer.root
        .find(
          (node) =>
            node.type === "button" && node.props["aria-expanded"] === (control === "minimize"),
        )
        .props.onClick(click);
    });
  const loadedUrls = () =>
    renderer.root
      .findAll((node) => node.type === "div" && "data-page-url" in node.props)
      .map((page) => page.props["data-page-url"]);

  it("ignores a URL minted for a page minimized since, and mints again when it is shown", async () => {
    let finishFirstMint: (url: string) => void = () => {};
    assets.refresh
      .mockReturnValueOnce(new Promise((resolve) => (finishFirstMint = resolve)))
      .mockResolvedValueOnce("https://environment.test/second");
    await act(async () => {
      renderer = create(<Thread />);
    });
    expect(loadedUrls()).toEqual([]);

    await press("minimize");
    await act(async () => finishFirstMint("https://environment.test/first"));
    expect(loadedUrls()).toEqual([]);

    await press("title row");
    expect(loadedUrls()).toEqual(["https://environment.test/second"]);
  });
});
