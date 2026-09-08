import { act, StrictMode, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useThreadFindHistory } from "./useThreadFindHistory";

type CitationHistoryPage = NonNullable<Parameters<typeof useThreadFindHistory>[1]>;

let renderer: ReactTestRenderer;
let status: ReturnType<typeof useThreadFindHistory>;

function Probe({
  requestKey,
  page,
}: {
  requestKey: string | null;
  page: CitationHistoryPage | null;
}) {
  const value = useThreadFindHistory(requestKey, page);
  useLayoutEffect(() => {
    status = value;
  }, [value]);
  return null;
}

async function render(requestKey: string | null, page: CitationHistoryPage | null) {
  await act(() => {
    renderer.update(
      <StrictMode>
        <Probe requestKey={requestKey} page={page} />
      </StrictMode>,
    );
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(
      <StrictMode>
        <Probe requestKey={null} page={null} />
      </StrictMode>,
    );
  });
});

afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("thread find history loading", () => {
  it("loads sequential pages without duplicate requests and finishes only at the oldest page", async () => {
    const load = vi.fn(() => true);
    const page = { cursor: "recent", loading: false, onLoadEarlier: load };
    await render("thread:1", page);
    await render("thread:1", { ...page });
    expect(load).toHaveBeenCalledTimes(1);
    expect(status).toBe("loading");

    await render("thread:1", { ...page, loading: true });
    expect(status).toBe("loading");
    expect(load).toHaveBeenCalledTimes(1);

    await render("thread:1", { ...page, cursor: "older" });
    expect(load).toHaveBeenCalledTimes(2);
    expect(status).not.toBeNull();
    await render("thread:1", null);
    expect(status).toBeNull();
  });

  it("does not loop on a failed page and allows an explicit retry", async () => {
    const load = vi.fn(() => true);
    const page = { cursor: "recent", loading: false, onLoadEarlier: load };
    await render("thread:1", page);
    await render("thread:1", { ...page, loading: true });
    await render("thread:1", { ...page });
    expect(status).toBe("incomplete");
    expect(load).toHaveBeenCalledTimes(1);

    await render("thread:2", page);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("offers retry if the thread cannot start a history request", async () => {
    const load = vi.fn(() => false);
    await render("thread:1", { cursor: "recent", loading: false, onLoadEarlier: load });
    expect(status).toBe("incomplete");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stops when find closes or the query clears, and isolates requests between threads", async () => {
    const load = vi.fn(() => true);
    const page = { cursor: "recent", loading: false, onLoadEarlier: load };
    await render(null, page);
    expect(load).not.toHaveBeenCalled();
    await render("thread-a:1", page);
    await render(null, { ...page, cursor: "older" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(status).toBeNull();

    await render("thread-b:1", page);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
