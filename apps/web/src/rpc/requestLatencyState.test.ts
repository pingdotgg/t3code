import { WS_METHODS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  acknowledgeRpcRequest,
  getSlowRpcAckRequests,
  resetRequestLatencyStateForTests,
  trackRpcRequestSent,
  LONG_RUNNING_RPC_ACK_THRESHOLD_MS,
  SLOW_RPC_ACK_THRESHOLD_MS,
  MAX_TRACKED_RPC_ACK_REQUESTS,
} from "./requestLatencyState";

describe("requestLatencyState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRequestLatencyStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks unary requests as slow when the ack threshold is exceeded", () => {
    trackRpcRequestSent("1", "server.getConfig");
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS - 1);
    expect(getSlowRpcAckRequests()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(getSlowRpcAckRequests()).toMatchObject([
      {
        requestId: "1",
        tag: "server.getConfig",
        thresholdMs: SLOW_RPC_ACK_THRESHOLD_MS,
      },
    ]);
  });

  it("clears the slow request once the server acknowledges it", () => {
    trackRpcRequestSent("1", "git.status");
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS);
    expect(getSlowRpcAckRequests()).toHaveLength(1);

    acknowledgeRpcRequest("1");
    expect(getSlowRpcAckRequests()).toEqual([]);
  });

  it("ignores long-lived subscribe requests", () => {
    trackRpcRequestSent("1", "subscribeServerConfig");
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS * 2);

    expect(getSlowRpcAckRequests()).toEqual([]);
  });

  it("ignores the long-lived preview automation connection", () => {
    trackRpcRequestSent("1", WS_METHODS.previewAutomationConnect);
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS * 2);

    expect(getSlowRpcAckRequests()).toEqual([]);
  });

  it.each(Object.values(WS_METHODS).filter((method) => method.startsWith("pullRequests.")))(
    "ignores pull request workspace request %s",
    (method) => {
      trackRpcRequestSent("1", method);
      vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS * 2);

      expect(getSlowRpcAckRequests()).toEqual([]);
    },
  );

  it("keeps ignoring untracked methods when a display tag is supplied", () => {
    trackRpcRequestSent(
      "1",
      WS_METHODS.previewAutomationConnect,
      `${WS_METHODS.previewAutomationConnect} · env-1`,
    );
    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS * 2);

    expect(getSlowRpcAckRequests()).toEqual([]);
  });

  it("gives provider updates a longer threshold before warning", () => {
    trackRpcRequestSent("1", WS_METHODS.serverUpdateProvider, "server.updateProvider · env-1");
    vi.advanceTimersByTime(LONG_RUNNING_RPC_ACK_THRESHOLD_MS - 1);
    expect(getSlowRpcAckRequests()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(getSlowRpcAckRequests()).toMatchObject([
      {
        requestId: "1",
        tag: "server.updateProvider · env-1",
        thresholdMs: LONG_RUNNING_RPC_ACK_THRESHOLD_MS,
      },
    ]);
  });

  it("evicts the oldest pending requests once the tracker reaches capacity", () => {
    for (let index = 0; index < MAX_TRACKED_RPC_ACK_REQUESTS + 1; index += 1) {
      trackRpcRequestSent(String(index), "server.getConfig");
    }

    vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS);

    const slowRequests = getSlowRpcAckRequests();
    expect(slowRequests).toHaveLength(MAX_TRACKED_RPC_ACK_REQUESTS);
    expect(slowRequests[0]?.requestId).toBe("1");
    expect(slowRequests.at(-1)?.requestId).toBe(String(MAX_TRACKED_RPC_ACK_REQUESTS));
  });
});
