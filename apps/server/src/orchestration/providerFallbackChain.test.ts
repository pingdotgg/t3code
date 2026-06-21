import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  beginProviderFallbackChain,
  completeProviderFallbackChain,
  markProviderFallbackInstanceAttempted,
  resetProviderFallbackChainsForTest,
} from "./providerFallbackChain.ts";

const threadId = ThreadId.make("thread-1");
const first = ProviderInstanceId.make("codex-first");
const second = ProviderInstanceId.make("codex-second");
const third = ProviderInstanceId.make("codex-third");

afterEach(resetProviderFallbackChainsForTest);

describe("provider fallback chain", () => {
  it("retains every attempted instance across consecutive runtime failures", () => {
    expect([...beginProviderFallbackChain(threadId, first)]).toEqual([first]);
    markProviderFallbackInstanceAttempted(threadId, second);

    expect([...beginProviderFallbackChain(threadId, second)]).toEqual([first, second]);
    markProviderFallbackInstanceAttempted(threadId, third);

    expect([...beginProviderFallbackChain(threadId, third)]).toEqual([first, second, third]);
  });

  it("starts a fresh chain after the active instance completes", () => {
    beginProviderFallbackChain(threadId, first);
    markProviderFallbackInstanceAttempted(threadId, second);
    completeProviderFallbackChain(threadId, second);

    expect([...beginProviderFallbackChain(threadId, second)]).toEqual([second]);
  });

  it("does not let a stale instance complete the current chain", () => {
    beginProviderFallbackChain(threadId, first);
    markProviderFallbackInstanceAttempted(threadId, second);
    completeProviderFallbackChain(threadId, first);

    expect([...beginProviderFallbackChain(threadId, second)]).toEqual([first, second]);
  });
});
