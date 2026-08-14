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
import type { ProviderUsageStripItem } from "../sidebar/ProviderUsageStrip.logic";

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
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="64.2"');
    expect(markup).toContain("7 days");
    expect(markup).toContain("$12.50");
    expect(markup).toContain("1 available");
    expect(markup).toContain("August recovery reset");
    expect(markup).toContain("Plan");
    expect(markup).toContain(">Use reset<");
  });

  it("uses the clamped percentage in progressbar values and labels", () => {
    const extremeItem = {
      ...item,
      snapshot: {
        ...snapshot,
        metrics: [{ ...snapshot.metrics[0]!, remainingPercent: 140 }],
      },
    };
    const markup = renderToStaticMarkup(
      <ProviderQuotaDetails
        canOperate={false}
        feedback={null}
        item={extremeItem}
        pendingReset={false}
        onRequestReset={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Weekly limit: 100% remaining"');
    expect(markup).toContain('aria-valuenow="100"');
    expect(markup).not.toContain("140% remaining");
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

  it("disables reset controls while a reset request is pending", () => {
    const markup = renderToStaticMarkup(
      <ProviderQuotaDetails
        canOperate
        feedback={null}
        item={item}
        pendingReset
        onRequestReset={() => {}}
      />,
    );

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Use reset<\/button>/u);
  });

  it("keeps a live region mounted and exposes reset feedback", () => {
    const emptyMarkup = renderToStaticMarkup(
      <ProviderQuotaDetails
        canOperate
        feedback={null}
        item={item}
        pendingReset={false}
        onRequestReset={() => {}}
      />,
    );
    const feedbackMarkup = renderToStaticMarkup(
      <ProviderQuotaDetails
        canOperate
        feedback="Reset applied."
        item={item}
        pendingReset={false}
        onRequestReset={() => {}}
      />,
    );

    expect(emptyMarkup).toContain('aria-live="polite"');
    expect(feedbackMarkup).toContain("Reset applied.");
  });

  it("offers a generic reset action for current count-only Codex inventory", () => {
    const countOnlySnapshot = {
      ...snapshot,
      bankedResets: { availableCount: 2, resets: [], detailsComplete: false },
    };
    const markup = renderToStaticMarkup(
      <ProviderQuotaDetails
        canOperate
        feedback={null}
        item={{ ...item, snapshot: countOnlySnapshot }}
        pendingReset={false}
        onRequestReset={() => {}}
      />,
    );

    expect(markup).toContain("2 available");
    expect(markup).toContain(">Use reset<");
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

  it("confirms a count-only reset without inventing credit details", () => {
    const markup = renderToStaticMarkup(
      <AlertDialog open>
        <ProviderQuotaResetConfirmationContent
          pending={false}
          reset={null}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </AlertDialog>,
    );

    expect(markup).toContain("Use banked reset?");
    expect(markup).toContain("No specific reset credit was reported");
    expect(markup).toContain("Confirm reset");
  });
});
