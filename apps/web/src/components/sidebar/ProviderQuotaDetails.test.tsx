import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderQuotaSnapshot,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderQuotaDetails,
  ProviderQuotaResetConfirmationContent,
} from "./ProviderQuotaDetails";
import { AlertDialog } from "../ui/alert-dialog";
import type { ProviderUsageStripItem } from "./ProviderUsageStrip.logic";

const reset = {
  id: "reset-august",
  title: "August recovery reset",
  description: "Restores the weekly allowance.",
  grantedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-31T00:00:00.000Z",
  resetType: "rate_limit",
  status: "available" as const,
};

const snapshot: ProviderQuotaSnapshot = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  status: "current",
  source: "codex-app-server",
  readAt: "2026-08-11T08:00:00.000Z",
  lastSuccessfulReadAt: "2026-08-11T08:00:00.000Z",
  headlineMetricKey: "weekly",
  metrics: [
    {
      key: "weekly",
      label: "Weekly limit",
      remainingPercent: 64.2,
      usedPercent: 35.8,
      resetsAt: "2026-08-17T00:00:00.000Z",
      windowMinutes: 10_080,
      blocking: true,
    },
  ],
  credits: { hasCredits: true, unlimited: false, balance: "$12.50" },
  bankedResets: { availableCount: 1, resets: [reset], detailsComplete: true },
  detail: { plan: "Pro" },
  message: null,
};

const item: ProviderUsageStripItem = {
  instanceId: snapshot.instanceId,
  driver: snapshot.driver,
  displayName: "Work Codex",
  percentage: 64,
  headlineLabel: "Weekly limit",
  snapshot,
};

describe("ProviderQuotaDetails", () => {
  it("renders every available normalized detail and the authorized reset control", () => {
    const markup = renderToStaticMarkup(
      <ProviderQuotaDetails
        canOperate
        feedback={null}
        item={item}
        pendingReset={false}
        onRequestReset={() => {}}
      />,
    );

    expect(markup).toContain("Work Codex");
    expect(markup).toContain("codex-app-server");
    expect(markup).toContain("Weekly limit");
    expect(markup).toContain("64.2% remaining");
    expect(markup).toContain("35.8% used");
    expect(markup).toContain("7 days");
    expect(markup).toContain("$12.50");
    expect(markup).toContain("1 available");
    expect(markup).toContain("August recovery reset");
    expect(markup).toContain("Plan");
    expect(markup).toContain(">Use reset<");
  });

  it("keeps reset controls hidden without operate access", () => {
    const markup = renderToStaticMarkup(
      <ProviderQuotaDetails
        canOperate={false}
        feedback={null}
        item={item}
        pendingReset={false}
        onRequestReset={() => {}}
      />,
    );
    expect(markup).not.toContain(">Use reset<");
  });

  it("keeps Codex reset controls hidden for other provider drivers", () => {
    const markup = renderToStaticMarkup(
      <ProviderQuotaDetails
        canOperate
        feedback={null}
        item={{ ...item, driver: ProviderDriverKind.make("future-provider") }}
        pendingReset={false}
        onRequestReset={() => {}}
      />,
    );
    expect(markup).not.toContain(">Use reset<");
  });

  it.each(["stale", "authRequired"] as const)(
    "keeps Codex reset controls hidden for a %s snapshot",
    (status) => {
      const markup = renderToStaticMarkup(
        <ProviderQuotaDetails
          canOperate
          feedback={null}
          item={{ ...item, snapshot: { ...snapshot, status } }}
          pendingReset={false}
          onRequestReset={() => {}}
        />,
      );

      expect(markup).not.toContain(">Use reset<");
    },
  );

  it("renders honest unsupported copy when no normalized snapshot exists", () => {
    const markup = renderToStaticMarkup(
      <ProviderQuotaDetails
        canOperate={false}
        feedback={null}
        item={{ ...item, percentage: null, headlineLabel: null, snapshot: null }}
        pendingReset={false}
        onRequestReset={() => {}}
      />,
    );
    expect(markup).toContain("does not provide normalized quota details");
  });
});

describe("ProviderQuotaResetConfirmationContent", () => {
  it("explicitly names the reset and expiry", () => {
    const markup = renderToStaticMarkup(
      <AlertDialog open>
        <ProviderQuotaResetConfirmationContent
          pending={false}
          reset={reset}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </AlertDialog>,
    );
    expect(markup).toContain("August recovery reset");
    expect(markup).toContain("expires");
    expect(markup).toContain("2026");
    expect(markup).toContain("Confirm reset");
    expect(markup).toContain('data-slot="alert-dialog-title"');
    expect(markup).toContain('data-slot="alert-dialog-description"');
  });
});
