import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { ProviderGroup } from "../../lib/modelOptions";
import { useProviderQuotas } from "./use-provider-quotas";

const MINUTE_MS = Date.UTC(2026, 9, 27, 12, 0);
const iso = (secondsIntoMinute: number) =>
  new Date(MINUTE_MS + secondsIntoMinute * 1000).toISOString();

function spentProvider(instanceId: string, resetsAt: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(0),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(0),
      windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 100, resetsAt }],
    },
  };
}

function group(instanceId: string): ProviderGroup {
  return {
    providerKey: instanceId,
    providerLabel: instanceId,
    models: [
      {
        key: `${instanceId}:model`,
        label: "Model",
        subtitle: "",
        providerKey: instanceId,
        providerLabel: instanceId,
        providerDriver: "codex",
        isDefault: false,
        isLegacy: false,
        capabilities: null,
        selection: { instanceId: ProviderInstanceId.make(instanceId), model: "model" },
      },
    ],
  };
}

it("refills each spent provider on time when two reset within the same minute", async () => {
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  vi.useFakeTimers({ now: MINUTE_MS + 10_000 });
  const config = { providers: [spentProvider("a", iso(30)), spentProvider("b", iso(40))] };
  const groups = [group("a"), group("b")];
  const seen: Array<Record<string, string | undefined>> = [];
  function Probe() {
    const quotas = useProviderQuotas(groups, config);
    useLayoutEffect(() => {
      seen.push({ a: quotas.byProvider.get("a")?.state, b: quotas.byProvider.get("b")?.state });
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  expect(seen.at(-1)).toEqual({ a: "exhausted", b: "exhausted" });

  await act(async () => vi.advanceTimersByTime(20_000));
  expect(seen.at(-1)).toEqual({ a: "available", b: "exhausted" });

  await act(async () => vi.advanceTimersByTime(10_000));
  expect(seen.at(-1)).toEqual({ a: "available", b: "available" });
  act(() => root.unmount());
});
