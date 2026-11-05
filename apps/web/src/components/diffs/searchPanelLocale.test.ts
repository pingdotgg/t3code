// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";

const widgetUrl = new URL("./editor/searchPanel.js", import.meta.resolve("@pierre/diffs"));
const { SearchPanelWidget } = (await import(/* @vite-ignore */ widgetUrl.href)) as {
  SearchPanelWidget: new (options: {
    textDocument: { search: () => number[][] };
    containerElement: HTMLElement;
    defaultQuery: string;
    allowReplace: boolean;
    scrollToMatch: () => void;
    applyReplace: () => void;
    onUpdate: () => void;
    onClose: () => void;
  }) => { cleanup: () => void };
};

afterEach(() => {
  document.documentElement.lang = "en";
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("switches open search controls in both directions and releases its locale observer", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  document.documentElement.lang = "zh-CN";
  const container = document.createElement("div");
  document.body.append(container);
  const search = vi.fn(() => []);
  const widget = new SearchPanelWidget({
    textDocument: { search },
    containerElement: container,
    defaultQuery: "needle",
    allowReplace: false,
    scrollToMatch: () => {},
    applyReplace: () => {},
    onUpdate: () => {},
    onClose: () => {},
  });
  expect(document.body.querySelector("input[data-search]")?.getAttribute("placeholder")).toBe(
    "搜索",
  );
  expect(document.body.querySelector('[aria-label="区分大小写"]')).not.toBeNull();
  document.documentElement.lang = "en";
  await vi.waitFor(() =>
    expect(document.body.querySelector("input[data-search]")?.getAttribute("placeholder")).toBe(
      "Search",
    ),
  );
  expect(document.body.querySelector("[data-matches]")?.textContent).toBe("No results");
  document.documentElement.lang = "zh-CN";
  await vi.waitFor(() => expect(document.body.querySelector('[aria-label="Close"]')).toBeNull());
  expect(document.body.querySelector("[data-matches]")?.textContent).toBe("无匹配结果");
  widget.cleanup();
  const calls = search.mock.calls.length;
  document.documentElement.lang = "en";
  await Promise.resolve();
  expect(search).toHaveBeenCalledTimes(calls);
  expect(document.querySelector("[data-search-panel]")).toBeNull();
});
