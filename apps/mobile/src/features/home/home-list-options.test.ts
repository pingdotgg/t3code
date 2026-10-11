import { EnvironmentId } from "@t3tools/contracts";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { HomeListOptionsProvider, useHomeListOptions } from "./home-list-options";

describe("home list options across layout changes", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const availableEnvironmentIds = new Set([environmentId]);
  let root: Root;
  let latest: ReturnType<typeof useHomeListOptions>;

  function ThreadList() {
    const state = useHomeListOptions(availableEnvironmentIds);
    useLayoutEffect(() => {
      latest = state;
    });
    return null;
  }

  async function showLayout(layout: "compact" | "sidebar") {
    await act(() => {
      root.render(
        createElement(
          HomeListOptionsProvider,
          { projectGroupingMode: "repository" },
          // Replace the list while keeping the workspace provider mounted.
          createElement(ThreadList, { key: layout }),
        ),
      );
    });
  }

  beforeEach(() => {
    // The hook probe renders no DOM, but ReactDOM needs an event target.
    const document = {
      nodeType: 9,
      addEventListener() {},
      removeEventListener() {},
    };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it.each([
    ["compact", "sidebar"],
    ["sidebar", "compact"],
  ] as const)(
    "retains filters through repeated %s → %s round trips and keeps clears",
    async (initialLayout, otherLayout) => {
      await showLayout(initialLayout);

      for (const [selectedEnvironmentId, selectedProjectKey] of [
        [environmentId, "repository:one"],
        [environmentId, "repository:two"],
        [environmentId, null],
        [null, null],
        [null, "repository:one"],
      ] as const) {
        await act(() => {
          latest.setSelectedEnvironmentId(selectedEnvironmentId);
          latest.setSelectedProjectKey(selectedProjectKey);
        });
        for (let cycle = 0; cycle < 3; cycle += 1) {
          for (const layout of [otherLayout, initialLayout]) {
            await showLayout(layout);
            expect(latest.options).toMatchObject({
              selectedEnvironmentId,
              selectedProjectKey,
              projectGroupingMode: "repository",
            });
          }
        }
        // Make the next selection (or clear it) from the opposite layout.
        await showLayout(otherLayout);
      }
    },
  );
});
