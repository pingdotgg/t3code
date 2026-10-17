import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ComposerBannerStack } from "./ComposerBannerStack";

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
});

function renderedText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : renderedText(child)))
    .join("");
}

function hostClassName(element: { readonly props: unknown }): string {
  const props = element.props;
  if (typeof props !== "object" || props === null || !("className" in props)) return "";
  return String(props.className ?? "");
}

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
      constructor(private readonly callback: (entries: { target: unknown }[]) => void) {}
      observe(target: unknown) {
        resize = () => this.callback([{ target }]);
      }
      unobserve() {}
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
  // The title measures separately and fits, so only the description offers details.
  const title = { querySelectorAll: () => [], clientWidth: 400, scrollWidth: 20 };
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
        createNodeMock: (element) => {
          if (element.type === "button") return { offsetWidth: 24 };
          if (element.type !== "span") return null;
          return hostClassName(element).includes("font-medium") ? title : text;
        },
      },
    );
  });
  const details = () => renderer.root.findAllByProps({ "aria-label": "Show notice details" });
  expect(details()).toHaveLength(0);
  text.scrollWidth = 300;
  await act(() => resize());
  expect(details()).toHaveLength(1);
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

it("offers notice details when a single-item title is clipped", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resize = () => {};
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: (entries: { target: unknown }[]) => void) {}
      observe(target: unknown) {
        resize = () => this.callback([{ target }]);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({ position: "static" }));
  const command =
    "Running: /usr/bin/zsh -lc 'sleep 600 > /tmp/t3-background-command-with-a-long-log-filename-for-truncation.log 2>&1'";
  const title = {
    querySelectorAll: () => [],
    clientWidth: 120,
    scrollWidth: 40,
  };
  await act(() => {
    renderer = create(
      <ComposerBannerStack
        items={[
          {
            id: "background-work",
            variant: "default",
            icon: null,
            title: command,
          },
        ]}
      />,
      {
        createNodeMock: (element) =>
          element.type === "span" && hostClassName(element).includes("font-medium")
            ? title
            : element.type === "button"
              ? { offsetWidth: 24 }
              : null,
      },
    );
  });
  const details = () => renderer.root.findAllByProps({ "aria-label": "Show title details" });
  expect(details()).toHaveLength(0);
  title.scrollWidth = 800;
  await act(() => resize());
  expect(details()).toHaveLength(1);
  expect(renderer.root.findAllByProps({ "aria-label": "Show notice details" })).toHaveLength(0);
  expect(renderedText(renderer.root.findByProps({ "aria-label": "Notice details" }))).toBe(command);
  title.scrollWidth = 40;
  await act(() => resize());
  expect(details()).toHaveLength(0);
});
