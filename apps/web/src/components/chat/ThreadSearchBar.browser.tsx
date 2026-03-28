import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadSearchBar } from "./ThreadSearchBar";

function dispatchInputKey(
  input: HTMLInputElement,
  key: string,
  options: { shiftKey?: boolean } = {},
) {
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: options.shiftKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function mountBar(props?: {
  query?: string;
  resultCount?: number;
  activeResultIndex?: number;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onQueryChange = vi.fn();
  const onNext = vi.fn();
  const onPrevious = vi.fn();
  const onClose = vi.fn();
  const inputRef = { current: null as HTMLInputElement | null };
  const screen = await render(
    <ThreadSearchBar
      query={props?.query ?? ""}
      resultCount={props?.resultCount ?? 0}
      activeResultIndex={props?.activeResultIndex ?? -1}
      inputRef={inputRef}
      onQueryChange={onQueryChange}
      onNext={onNext}
      onPrevious={onPrevious}
      onClose={onClose}
    />,
    { container: host },
  );

  return {
    inputRef,
    onQueryChange,
    onNext,
    onPrevious,
    onClose,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ThreadSearchBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders count states for empty, missing, and active results", async () => {
    const empty = await mountBar();
    try {
      await expect
        .element(page.getByTestId("thread-search-count"))
        .toHaveTextContent("Type to search");
    } finally {
      await empty.cleanup();
    }

    const noMatches = await mountBar({ query: "needle", resultCount: 0, activeResultIndex: -1 });
    try {
      await expect.element(page.getByTestId("thread-search-count")).toHaveTextContent("No matches");
    } finally {
      await noMatches.cleanup();
    }

    const active = await mountBar({ query: "needle", resultCount: 3, activeResultIndex: 1 });
    try {
      await expect.element(page.getByTestId("thread-search-count")).toHaveTextContent("2 / 3");
    } finally {
      await active.cleanup();
    }
  });

  it("routes Enter, Shift+Enter, and Escape to the expected callbacks", async () => {
    const mounted = await mountBar({ query: "needle", resultCount: 2, activeResultIndex: 0 });

    try {
      const input = document.querySelector<HTMLInputElement>('[data-testid="thread-search-input"]');
      expect(input).toBeTruthy();
      input!.focus();
      dispatchInputKey(input!, "Enter");
      dispatchInputKey(input!, "Enter", { shiftKey: true });
      dispatchInputKey(input!, "Escape");

      expect(mounted.onNext).toHaveBeenCalledTimes(1);
      expect(mounted.onPrevious).toHaveBeenCalledTimes(1);
      expect(mounted.onClose).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables navigation buttons when there are no results", async () => {
    const mounted = await mountBar({ query: "needle", resultCount: 0, activeResultIndex: -1 });

    try {
      await expect.element(page.getByLabelText("Previous search result")).toBeDisabled();
      await expect.element(page.getByLabelText("Next search result")).toBeDisabled();
    } finally {
      await mounted.cleanup();
    }
  });
});
