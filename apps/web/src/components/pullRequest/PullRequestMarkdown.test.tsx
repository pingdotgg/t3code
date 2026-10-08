// @vitest-environment jsdom

import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const anchorClick = vi.fn();

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => (
    <a href={text} onClick={(event) => anchorClick(event.defaultPrevented)}>
      link
    </a>
  ),
}));

import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  anchorClick.mockReset();
  vi.unstubAllGlobals();
});

async function clickLink(init: MouseEventInit) {
  const onOpenUrl = vi.fn(() => true);
  await act(async () =>
    root.render(
      <PullRequestMarkdownContext value={{ repositoryUrl: null, threadRef: null, onOpenUrl }}>
        <PullRequestMarkdown
          text="https://github.com/acme/app/issues/2"
          cwd="/tmp/project"
          environmentId={"environment-1" as EnvironmentId}
        />
      </PullRequestMarkdownContext>,
    ),
  );
  const anchor = container.querySelector("a");
  if (!anchor) throw new Error("Link was not rendered");
  const notPrevented = anchor.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
  );
  return { onOpenUrl, notPrevented };
}

describe("PullRequestMarkdown links", () => {
  it("opens a plain primary click in the app", async () => {
    const { onOpenUrl, notPrevented } = await clickLink({});

    expect(onOpenUrl).toHaveBeenCalledWith("https://github.com/acme/app/issues/2");
    expect(notPrevented).toBe(false);
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "leaves a %o click to the link's own handling",
    async (modifier) => {
      const { onOpenUrl, notPrevented } = await clickLink(modifier);

      expect(onOpenUrl).not.toHaveBeenCalled();
      expect(notPrevented).toBe(true);
      expect(anchorClick).toHaveBeenCalledWith(false);
    },
  );
});
