import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { UsagePage } from "./UsagePage";

const codexId = ProviderInstanceId.make("codex-work");
const codex = ProviderDriverKind.make("codex");

vi.mock("../../state/usage", () => ({
  useUsage: () => ({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments: [],
    isPending: false,
    isPartial: false,
    refresh: () => {},
  }),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [codexId]: { driver: codex, displayName: "Work Codex", enabled: true },
        },
      },
      providers: [{ instanceId: codexId }],
    },
  }),
}));
vi.mock("../../state/providerQuota", () => ({
  usePrimaryProviderQuota: () => ({
    summary: {
      readAt: "2026-08-12T00:00:00.000Z",
      instances: [
        {
          instanceId: codexId,
          driver: codex,
          status: "current",
          source: "test",
          readAt: "2026-08-12T00:00:00.000Z",
          lastSuccessfulReadAt: "2026-08-12T00:00:00.000Z",
          headlineMetricKey: "weekly",
          metrics: [
            {
              key: "weekly",
              label: "Weekly limit",
              remainingPercent: 64,
              usedPercent: 36,
              resetsAt: "2026-08-17T00:00:00.000Z",
              windowMinutes: 10_080,
              blocking: true,
            },
          ],
          credits: null,
          bankedResets: null,
          detail: {},
          message: null,
        },
      ],
    },
    isPending: false,
    error: null,
    refresh: () => {},
    consumeReset: async () => null,
  }),
}));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false }),
}));

describe("UsagePage", () => {
  it("places live provider limits above the existing historical usage report", () => {
    const markup = renderToStaticMarkup(
      <UsagePage requestedProviderId={codexId} onProviderSelect={() => {}} />,
    );

    const limitsIndex = markup.indexOf('id="provider-limits"');
    const historicalIndex = markup.indexOf("Raw token cost");
    expect(limitsIndex).toBeGreaterThan(-1);
    expect(historicalIndex).toBeGreaterThan(-1);
    expect(limitsIndex).toBeLessThan(historicalIndex);
    expect(markup).toContain("Work Codex");
    expect(markup).toContain("64%");
    expect(markup).toContain("Weekly limit");
    expect(markup).toContain("Processed tokens");
  });
});
