import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetVscodeIconLoadStoreForTests,
  getVscodeIconLoadStatus,
  markVscodeIconFailed,
  markVscodeIconLoaded,
  subscribeVscodeIconLoadStatus,
} from "./vscode-icon-load-store";

describe("vscode icon load store", () => {
  beforeEach(() => {
    __resetVscodeIconLoadStoreForTests();
  });

  it("defaults unknown urls to loading", () => {
    expect(getVscodeIconLoadStatus("/icons/file.svg")).toBe("loading");
  });

  it("notifies same-url subscribers once when the status changes", () => {
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    subscribeVscodeIconLoadStatus("/icons/file.svg", firstListener);
    subscribeVscodeIconLoadStatus("/icons/file.svg", secondListener);

    markVscodeIconLoaded("/icons/file.svg");
    markVscodeIconLoaded("/icons/file.svg");

    expect(getVscodeIconLoadStatus("/icons/file.svg")).toBe("loaded");
    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).toHaveBeenCalledOnce();
  });

  it("does not notify unsubscribed listeners", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVscodeIconLoadStatus("/icons/file.svg", listener);

    unsubscribe();
    markVscodeIconFailed("/icons/file.svg");

    expect(getVscodeIconLoadStatus("/icons/file.svg")).toBe("error");
    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates subscribers by url", () => {
    const listener = vi.fn();

    subscribeVscodeIconLoadStatus("/icons/file.svg", listener);
    markVscodeIconLoaded("/icons/other.svg");

    expect(getVscodeIconLoadStatus("/icons/file.svg")).toBe("loading");
    expect(getVscodeIconLoadStatus("/icons/other.svg")).toBe("loaded");
    expect(listener).not.toHaveBeenCalled();
  });
});
