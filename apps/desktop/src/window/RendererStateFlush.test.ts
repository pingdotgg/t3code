import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  requestRendererStateFlush,
  type RendererStateFlushAcknowledgement,
} from "./RendererStateFlush.ts";

describe("requestRendererStateFlush", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for the matching renderer acknowledgement", async () => {
    const target = {};
    const send = vi.fn();
    const unsubscribe = vi.fn();
    let notify: ((acknowledgement: RendererStateFlushAcknowledgement) => void) | undefined;
    const pending = requestRendererStateFlush({
      requestId: "request-1",
      target,
      send,
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    });

    expect(send).toHaveBeenCalledWith("request-1");
    notify?.({ sender: {}, requestId: "request-1", succeeded: true });
    notify?.({ sender: target, requestId: "other-request", succeeded: true });

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    notify?.({ sender: target, requestId: "request-1", succeeded: true });

    await expect(pending).resolves.toBe("flushed");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("removes its listener when the Effect timeout aborts the request", async () => {
    const unsubscribe = vi.fn();
    const controller = new AbortController();
    const pending = requestRendererStateFlush({
      requestId: "request-2",
      target: {},
      signal: controller.signal,
      send: vi.fn(),
      subscribe: () => unsubscribe,
    });

    controller.abort();

    await expect(pending).resolves.toBe("timed-out");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
