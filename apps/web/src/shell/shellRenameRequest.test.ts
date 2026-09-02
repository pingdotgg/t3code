import { describe, expect, it, vi } from "vite-plus/test";

import { requestShellRename, subscribeShellRenameRequests } from "./shellRenameRequest";

describe("shell rename requests", () => {
  it("delivers to a mounted subscriber right away", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeShellRenameRequests("env:a", listener);
    requestShellRename("env:a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    requestShellRename("env:a");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("holds an unclaimed request for the view that mounts next", () => {
    requestShellRename("env:b");
    const listener = vi.fn();
    const unsubscribe = subscribeShellRenameRequests("env:b", listener);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();

    const again = vi.fn();
    subscribeShellRenameRequests("env:b", again)();
    expect(again).not.toHaveBeenCalled();
  });

  it("drops a pending request when a view for another thread mounts", () => {
    requestShellRename("env:c");
    const other = vi.fn();
    subscribeShellRenameRequests("env:other", other)();
    expect(other).not.toHaveBeenCalled();

    const target = vi.fn();
    subscribeShellRenameRequests("env:c", target)();
    expect(target).not.toHaveBeenCalled();
  });
});
