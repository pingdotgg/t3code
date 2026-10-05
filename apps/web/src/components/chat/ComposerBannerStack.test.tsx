import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ComposerBannerStack } from "./ComposerBannerStack";
import { contextReportBannerItem } from "./ComposerContextReport";
import { parseContextReport } from "@t3tools/shared/contextReport";

vi.mock("../ui/popover", () => ({
  Popover: "popover",
  PopoverTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  PopoverPopup: "popup",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));

let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("shows a replacement context report and dismisses it from the composer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const report = parseContextReport(`## Context Usage
**Model:** claude-sonnet-5
**Tokens:** 79.5k / 200k (40%)
### MCP Tools
| Tool | Server | Tokens |
|---|---|---|
| mcp__fixture__tool | fixture | 81 |
`)!;
  const onDismiss = () => renderer.update(<ComposerBannerStack items={[]} />);
  await act(() => {
    renderer = create(
      <ComposerBannerStack items={[contextReportBannerItem("report-1", report, onDismiss)]} />,
    );
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("79.5k / 200k (40%)");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("mcp__fixture__tool");
  await act(() => renderer.root.findByProps({ "aria-expanded": false }).props.onClick());
  expect(JSON.stringify(renderer.toJSON())).toContain("mcp__fixture__tool");
  await act(() =>
    renderer.update(
      <ComposerBannerStack
        items={[contextReportBannerItem("report-2", { ...report, usedTokens: "90k" }, onDismiss)]}
      />,
    ),
  );
  expect(JSON.stringify(renderer.toJSON())).toContain("90k / 200k (40%)");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("79.5k / 200k (40%)");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("mcp__fixture__tool");
  await act(() =>
    renderer.root.findByProps({ "aria-label": "Dismiss context window" }).props.onClick(),
  );
  await act(() => {
    vi.runAllTimers();
  });
  expect(renderer.toJSON()).toBeNull();
});

it("only offers notice details when the description cannot fit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resize = () => {};
  let mutate = () => {};
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutate = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  let position = "static";
  vi.stubGlobal("getComputedStyle", () => ({ position }));
  let availableWidth = 200;
  const nested = { clientWidth: 100, scrollWidth: 80 };
  const text = {
    querySelectorAll: () => [nested],
    get clientWidth() {
      return (
        availableWidth -
        (renderer?.root.findAllByProps({ "aria-label": "Show notice details" }).length ? 28 : 0)
      );
    },
    scrollWidth: 80,
  };
  await act(() => {
    renderer = create(
      <ComposerBannerStack
        items={[
          {
            id: "usage",
            variant: "info",
            icon: null,
            title: "Usage limits",
            description: "OpenCode",
          },
        ]}
      />,
      {
        createNodeMock: (element) =>
          element.type === "span" ? text : element.type === "button" ? { offsetWidth: 24 } : null,
      },
    );
  });
  const details = () => renderer.root.findAllByProps({ "aria-label": "Show notice details" });
  expect(details()).toHaveLength(0);
  text.scrollWidth = 300;
  await act(() => resize());
  expect(details()).toHaveLength(1);
  // It fits without the icon: the icon must not keep its own overflow alive.
  availableWidth = 308;
  await act(() => resize());
  expect(details()).toHaveLength(0);
  text.scrollWidth = 80;
  await act(() => resize());
  expect(details()).toHaveLength(0);
  nested.scrollWidth = 500;
  await act(() => mutate());
  expect(details()).toHaveLength(1);
  nested.scrollWidth = 80;
  await act(() => mutate());
  expect(details()).toHaveLength(0);
  position = "absolute";
  await act(() => resize());
  expect(details()).toHaveLength(1);
  position = "static";
  await act(() => resize());
  expect(details()).toHaveLength(0);
});
