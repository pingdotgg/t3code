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
const origin = {
  instanceId: first,
  displayName: "Codex First",
  failure: { kind: "rate-limit" as const, message: "Usage limit reached." },
  modelSelection: { instanceId: first, model: "gpt-5" },
  session: undefined,
};

afterEach(resetProviderFallbackChainsForTest);

describe("provider fallback chain", () => {
  it("retains every attempted instance across consecutive runtime failures", () => {
    expect([...beginProviderFallbackChain(threadId, first, origin).attemptedInstanceIds]).toEqual([
      first,
    ]);
    markProviderFallbackInstanceAttempted(threadId, second);

    const secondAttempt = beginProviderFallbackChain(threadId, second, {
      ...origin,
      instanceId: second,
    });
    expect([...secondAttempt.attemptedInstanceIds]).toEqual([first, second]);
    expect(secondAttempt.origin).toEqual(origin);
    markProviderFallbackInstanceAttempted(threadId, third);

    expect([...beginProviderFallbackChain(threadId, third, origin).attemptedInstanceIds]).toEqual([
      first,
      second,
      third,
    ]);
  });

  it("starts a fresh chain after the active instance completes", () => {
    beginProviderFallbackChain(threadId, first, origin);
    markProviderFallbackInstanceAttempted(threadId, second);
    completeProviderFallbackChain(threadId, second);

    expect([
      ...beginProviderFallbackChain(threadId, second, {
        ...origin,
        instanceId: second,
      }).attemptedInstanceIds,
    ]).toEqual([second]);
  });

  it("does not let a stale instance complete the current chain", () => {
    beginProviderFallbackChain(threadId, first, origin);
    markProviderFallbackInstanceAttempted(threadId, second);
    completeProviderFallbackChain(threadId, first);

    expect([
      ...beginProviderFallbackChain(threadId, second, {
        ...origin,
        instanceId: second,
      }).attemptedInstanceIds,
    ]).toEqual([first, second]);
  });
});
