import type { EnvironmentId, ProviderQuotaSummary } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installReactHookTestDom, mountReactHookTestComponent } from "../test/reactDomHookHarness";

const mocks = vi.hoisted(() => ({
  appAtomRegistry: { refresh: vi.fn() },
  environmentId: "quota-recovery-primary" as EnvironmentId,
  serverEnvironment: {
    configProjection: vi.fn(),
    consumeProviderQuotaReset: { label: "consume-provider-quota-reset" },
    providerQuota: vi.fn(),
  },
}));

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: mocks.appAtomRegistry }));
vi.mock("./environments", () => ({
  usePrimaryEnvironmentId: () => mocks.environmentId,
}));
vi.mock("./server", () => ({ serverEnvironment: mocks.serverEnvironment }));
vi.mock("./use-atom-command", () => ({
  useAtomCommand: () => async () => AsyncResult.success("reset"),
}));

import { usePrimaryProviderQuota } from "./providerQuota";

describe("provider quota live recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.appAtomRegistry.refresh.mockReset();
    mocks.serverEnvironment.configProjection.mockReset();
    mocks.serverEnvironment.providerQuota.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a canceled Codex quota read that settled as unknown within five seconds", async () => {
    const quotaAtom = Atom.make(
      AsyncResult.success<ProviderQuotaSummary, never>({
        readAt: "2026-08-12T08:00:00.000Z",
        instances: [
          {
            instanceId: "codex",
            driver: "codex",
            status: "unknown",
          } as never,
        ],
      }),
    );
    const projectionAtom = Atom.make(
      AsyncResult.success({
        config: { providers: [{ enabled: true }] },
        latestEvent: { type: "snapshot" },
      } as never),
    );
    const registry = AtomRegistry.make();
    const dom = installReactHookTestDom();
    mocks.serverEnvironment.providerQuota.mockReturnValue(quotaAtom);
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

    expect(mocks.appAtomRegistry.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(mocks.appAtomRegistry.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.appAtomRegistry.refresh).toHaveBeenCalledExactlyOnceWith(quotaAtom);

    await mounted.unmount();
    dom.cleanup();
    registry.dispose();
  });

  it("lets the persistent usage strip own polling while a detail consumer is mounted", async () => {
    const quotaAtom = Atom.make(
      AsyncResult.success<ProviderQuotaSummary, never>({
        readAt: "2026-08-12T08:00:00.000Z",
        instances: [],
      }),
    );
    const projectionAtom = Atom.make(
      AsyncResult.success({
        config: { providers: [] },
        latestEvent: { type: "snapshot" },
      } as never),
    );
    const registry = AtomRegistry.make();
    const dom = installReactHookTestDom();
    mocks.serverEnvironment.providerQuota.mockReturnValue(quotaAtom);
    mocks.serverEnvironment.configProjection.mockReturnValue(projectionAtom);

    const mounted = await mountReactHookTestComponent(
      createElement(
        RegistryContext.Provider,
        { value: registry },
        createElement(() => {
          usePrimaryProviderQuota();
          usePrimaryProviderQuota();
          return null;
        }),
      ),
      dom.document,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.appAtomRegistry.refresh).toHaveBeenCalledExactlyOnceWith(quotaAtom);

    await mounted.unmount();
    dom.cleanup();
    registry.dispose();
  });
});
