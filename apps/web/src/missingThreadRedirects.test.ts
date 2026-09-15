import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  recordMissingThreadRedirect,
  subscribeMissingThreadRedirect,
} from "./missingThreadRedirects.ts";

const redirect = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("missing-thread redirect provenance", () => {
  it("delivers a recorded redirect to every current subscriber with its identity", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeMissingThreadRedirect(first);
    subscribeMissingThreadRedirect(second);

    recordMissingThreadRedirect(redirect);

    expect(first).toHaveBeenCalledExactlyOnceWith(redirect);
    expect(second).toHaveBeenCalledExactlyOnceWith(redirect);
    unsubscribeFirst();
  });

  it("stops delivering to an unsubscribed listener", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMissingThreadRedirect(listener);
    unsubscribe();

    recordMissingThreadRedirect(redirect);

    expect(listener).not.toHaveBeenCalled();
  });
});
