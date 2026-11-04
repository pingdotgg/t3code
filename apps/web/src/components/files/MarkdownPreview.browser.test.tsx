import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { act, render } from "../../../test/render";
import { MarkdownDetails } from "../chat/MarkdownDetails";
import { MarkdownPreview } from "./MarkdownPreview";
import { getMarkdownFindTarget, requestMarkdownFindOpen } from "./markdownFindActionBus";

const highlighted = (name = "t3-markdown-find-active") =>
  [...(CSS.highlights.get(name) ?? [])].map((range) => (range as Range).toString());

it("finds inline phrases, preserves Unicode offsets, and excludes controls and block boundaries", async () => {
  await using screen = await render(
    <MarkdownPreview>
      <p>
        İstanbul 🐈 <strong>NEE</strong>dle
      </p>
      <p>needle</p>
      <p>separate</p>
      <p>blocks</p>
      <div role="toolbar">needle</div>
      <div data-thread-find-ignore>needle</div>
      <pre>
        <code>
          <span>nee</span>
          <span>dle</span>
        </code>
      </pre>
    </MarkdownPreview>,
  );
  const paragraph = screen.container.querySelector("p")!;
  await act(() => {
    expect(requestMarkdownFindOpen(paragraph)).toBe(true);
  });
  const input = screen.getByRole("searchbox", { name: "Find in file" });
  await userEvent.fill(input, "needle");
  await vi.waitFor(() => expect(highlighted()).toEqual(["NEEdle"]));
  expect(highlighted("t3-markdown-find")).toEqual(["needle", "needle"]);
  await userEvent.keyboard("{Enter}");
  expect(highlighted()).toEqual(["needle"]);
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  expect(highlighted()).toEqual(["NEEdle"]);
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  expect(highlighted()).toEqual(["needle"]);
  await userEvent.fill(input, "separateblocks");
  await vi.waitFor(() => expect(highlighted()).toEqual([]));
  expect(highlighted("t3-markdown-find")).toEqual([]);
  await userEvent.keyboard("{Escape}");
  await expect.element(input).not.toBeInTheDocument();
  expect(document.activeElement).toBe(screen.container.querySelector("[data-markdown-preview]"));
  expect(CSS.highlights.has("t3-markdown-find")).toBe(false);
  await act(() => {
    requestMarkdownFindOpen(paragraph);
  });
  await expect.element(screen.getByRole("searchbox", { name: "Find in file" })).toHaveValue("");
});

it("reveals folded Markdown and refreshes matches when the rendered text changes", async () => {
  const content = (text: string) => (
    <MarkdownPreview>
      <MarkdownDetails>
        <summary>Details</summary>
        <p>{text}</p>
      </MarkdownDetails>
    </MarkdownPreview>
  );
  await using screen = await render(content("Hidden needle"));
  const preview = screen.container.querySelector<HTMLElement>("[data-markdown-preview]")!;
  await act(() => {
    requestMarkdownFindOpen(preview);
  });
  await userEvent.fill(screen.getByRole("searchbox"), "needle");
  await vi.waitFor(() => {
    expect(highlighted()).toEqual(["needle"]);
    expect(screen.container.querySelector("[data-markdown-details-open=true]")).not.toBeNull();
  });
  await screen.rerender(content("Updated needle and needle"));
  await vi.waitFor(() => expect(highlighted("t3-markdown-find")).toEqual(["needle"]));
  await userEvent.fill(screen.getByRole("searchbox"), "missing");
  await vi.waitFor(() => expect(highlighted()).toEqual([]));
});

it("reuses its DOM index while typing and its ranges while navigating", async () => {
  await using screen = await render(
    <MarkdownPreview>
      <p>needle NEEDLE needle</p>
    </MarkdownPreview>,
  );
  using ranges = vi.spyOn(document, "createRange");
  const preview = screen.container.querySelector<HTMLElement>("[data-markdown-preview]")!;
  await act(() => {
    requestMarkdownFindOpen(preview);
  });
  expect(ranges).not.toHaveBeenCalled();
  await userEvent.fill(screen.getByRole("searchbox"), "needle");
  await vi.waitFor(() => expect(highlighted()).toEqual(["needle"]));
  ranges.mockClear();
  using traversal = vi.spyOn(Node.prototype, "childNodes", "get");
  await userEvent.keyboard("{Enter}{Enter}{Enter}");
  expect(ranges).not.toHaveBeenCalled();
  expect(traversal).not.toHaveBeenCalled();
  await userEvent.fill(screen.getByRole("searchbox"), "NEE");
  await vi.waitFor(() => expect(highlighted()).toEqual(["nee"]));
  expect(traversal).not.toHaveBeenCalled();
});

it("reveals code matches inside horizontal and vertical scroll containers without moving the page", async () => {
  await using screen = await render(
    <div style={{ display: "flex", width: 360, height: 240 }}>
      <MarkdownPreview>
        <p>Start</p>
        <div style={{ height: 600 }} />
        <pre style={{ overflow: "auto", whiteSpace: "pre", fontFamily: "monospace" }}>
          needle {"x".repeat(400)}needle
        </pre>
      </MarkdownPreview>
    </div>,
  );
  const paragraph = screen.container.querySelector("p")!;
  await act(() => {
    requestMarkdownFindOpen(paragraph);
  });
  await userEvent.fill(screen.getByRole("searchbox"), "needle");
  await vi.waitFor(() => expect(highlighted()).toEqual(["needle"]));
  const pageTop = window.scrollY;
  await userEvent.keyboard("{Enter}");
  const pre = screen.container.querySelector("pre")!;
  const viewport = screen.container.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  )!;
  await vi.waitFor(() => {
    const range = [...CSS.highlights.get("t3-markdown-find-active")!][0] as Range;
    const rect = range.getBoundingClientRect();
    expect(pre.scrollLeft).toBeGreaterThan(0);
    expect(rect.left).toBeGreaterThanOrEqual(pre.getBoundingClientRect().left);
    expect(rect.right).toBeLessThanOrEqual(pre.getBoundingClientRect().right + 1);
    expect(rect.top).toBeGreaterThanOrEqual(viewport.getBoundingClientRect().top);
    expect(rect.bottom).toBeLessThanOrEqual(viewport.getBoundingClientRect().bottom);
  });
  expect(window.scrollY).toBe(pageTop);
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  expect(pre.scrollLeft).toBe(0);
});

it("routes file toolbar focus to the visible preview, leaving hidden tabs and chat alone", async () => {
  await using screen = await render(
    <>
      <div data-file-preview-panel>
        <button>File action</button>
        <div hidden>
          <MarkdownPreview>
            <p>Hidden</p>
          </MarkdownPreview>
        </div>
        <MarkdownPreview>
          <p>Visible</p>
        </MarkdownPreview>
      </div>
      <textarea aria-label="Chat" />
    </>,
  );
  const visible = screen.container.querySelectorAll("[data-markdown-preview]")[1]!;
  expect(getMarkdownFindTarget(screen.container.querySelector("button"))).toBe(visible);
  expect(getMarkdownFindTarget(screen.container.querySelector("textarea"))).toBeNull();
  expect(getMarkdownFindTarget(screen.container.querySelector("textarea"), true)).toBe(visible);
  expect(requestMarkdownFindOpen(screen.container.querySelector("[hidden] p"))).toBe(false);
});
