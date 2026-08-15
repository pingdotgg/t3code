import type {
  EnvironmentId,
  ProviderQuotaConsumeResetInput,
  ProviderQuotaConsumeResetOutcome,
  ProviderQuotaSummary,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installReactHookTestDom, mountReactHookTestComponent } from "../test/reactDomHookHarness";

const mocks = vi.hoisted(() => ({
  appAtomRegistry: { refresh: vi.fn() },
  primaryEnvironmentId: null as EnvironmentId | null,
  serverEnvironment: {
    configProjection: vi.fn(),
    consumeProviderQuotaReset: { label: "consume-provider-quota-reset" },
    providerQuota: vi.fn(),
  },
}));

vi.mock("../hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: mocks.appAtomRegistry }));
vi.mock("./environments", () => ({
  usePrimaryEnvironmentId: () => mocks.primaryEnvironmentId,
}));
vi.mock("./server", () => ({ serverEnvironment: mocks.serverEnvironment }));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: () => async () => AsyncResult.success("reset"),
}));

import {
  consumeAndRefreshProviderQuota,
  refreshProviderQuota,
  resolveProviderQuotaView,
  usePrimaryProviderQuota,
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
  beforeEach(() => {
    mocks.appAtomRegistry.refresh.mockReset();
    mocks.serverEnvironment.configProjection.mockReset();
    mocks.serverEnvironment.providerQuota.mockReset();
    mocks.primaryEnvironmentId = null;
  });

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

  it("refreshes the quota query when a consume command rejects", async () => {
    const refresh = vi.fn();
    const consume = vi.fn(async () => Promise.reject(new Error("transport failed")));

    await expect(
      consumeAndRefreshProviderQuota({ environmentId, input, consume, refresh }),
    ).rejects.toThrow("transport failed");
    expect(refresh).toHaveBeenCalledExactlyOnceWith(environmentId);
  });

  it("refreshes only the primary quota query after provider reconciliation completes", async () => {
    const primaryEnvironmentId = "primary" as EnvironmentId;
    const primaryQuotaAtom = Atom.make(AsyncResult.initial<ProviderQuotaSummary, never>(false));
    const secondaryQuotaAtom = Atom.make(AsyncResult.initial<ProviderQuotaSummary, never>(false));
    const projectionAtom = Atom.make(
      AsyncResult.success({ latestEvent: { type: "snapshot" } } as never),
    );
    const registry = AtomRegistry.make();
    const dom = installReactHookTestDom();
    mocks.primaryEnvironmentId = primaryEnvironmentId;
    mocks.serverEnvironment.providerQuota.mockImplementation(({ environmentId: target }) =>
      target === primaryEnvironmentId ? primaryQuotaAtom : secondaryQuotaAtom,
    );
    mocks.serverEnvironment.configProjection.mockReturnValue(projectionAtom);

    const mounted = await mountReactHookTestComponent(
      createElement(
        RegistryContext.Provider,
        { value: registry },
        createElement(() => {
          usePrimaryProviderQuota();
          return null;
        }),
      ),
      dom.document,
    );

    await act(async () => {
      registry.set(
        projectionAtom,
        AsyncResult.success({ latestEvent: { type: "settingsUpdated" } } as never),
      );
    });

    expect(mocks.appAtomRegistry.refresh).not.toHaveBeenCalled();

    await act(async () => {
      registry.set(
        projectionAtom,
        AsyncResult.success({ latestEvent: { type: "providerStatuses" } } as never),
      );
    });

    expect(mocks.appAtomRegistry.refresh).toHaveBeenCalledExactlyOnceWith(primaryQuotaAtom);
    expect(mocks.appAtomRegistry.refresh).not.toHaveBeenCalledWith(secondaryQuotaAtom);

    await mounted.unmount();
    dom.cleanup();
    registry.dispose();
  });
});
