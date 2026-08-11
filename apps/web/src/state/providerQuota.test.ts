import type {
  ProviderQuotaConsumeResetInput,
  ProviderQuotaConsumeResetOutcome,
  ProviderQuotaSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  consumeAndRefreshProviderQuota,
  refreshProviderQuota,
  resolveProviderQuotaView,
} from "./providerQuota";

const environmentId = "primary" as never;
const summary: ProviderQuotaSummary = {
  readAt: "2026-08-11T00:00:00.000Z",
  instances: [],
};
const input: ProviderQuotaConsumeResetInput = {
  instanceId: "codex-main" as never,
  creditId: null,
  idempotencyKey: "attempt-1",
};

describe("provider quota state", () => {
  it("exposes a successful primary-environment quota summary", () => {
    expect(resolveProviderQuotaView(AsyncResult.success(summary), true)).toEqual({
      summary,
      isPending: false,
      error: null,
    });
  });

  it("stays pending while the primary quota query is loading", () => {
    expect(
      resolveProviderQuotaView(AsyncResult.initial<ProviderQuotaSummary, never>(true), true),
    ).toEqual({
      summary: null,
      isPending: true,
      error: null,
    });
  });

  it("treats an older server's unknown quota method as unavailable data", () => {
    const error = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "Unknown RPC method server.getProviderQuota",
        cause: new Error("unknown method"),
      }),
    });

    expect(resolveProviderQuotaView(AsyncResult.failure(Cause.fail(error)), true)).toEqual({
      summary: null,
      isPending: false,
      error: null,
    });
  });

  it("refreshes the exact primary environment quota query on demand", () => {
    const refresh = vi.fn();

    refreshProviderQuota({ environmentId, refresh });

    expect(refresh).toHaveBeenCalledExactlyOnceWith(environmentId);
  });

  it.each([
    AsyncResult.success<ProviderQuotaConsumeResetOutcome, never>("reset"),
    AsyncResult.failure<ProviderQuotaConsumeResetOutcome, Error>(Cause.fail(new Error("denied"))),
  ])("refreshes the exact query after every consume outcome", async (outcome) => {
    const refresh = vi.fn();
    const consume = vi.fn(async () => outcome);

    await expect(
      consumeAndRefreshProviderQuota({ environmentId, input, consume, refresh }),
    ).resolves.toBe(outcome);
    expect(consume).toHaveBeenCalledExactlyOnceWith({ environmentId, input });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(environmentId);
  });
});
