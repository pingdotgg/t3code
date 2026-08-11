import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderQuotaSnapshot,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ProviderUsageStripItem } from "../sidebar/ProviderUsageStrip.logic";
import { prepareProviderResetConsumption, ProviderQuotaSectionView } from "./ProviderQuotaSection";

function item(input: {
  readonly id: string;
  readonly driver: string;
  readonly displayName: string;
  readonly percentage: number | null;
  readonly metricLabel: string;
}): ProviderUsageStripItem {
  const instanceId = ProviderInstanceId.make(input.id);
  const driver = ProviderDriverKind.make(input.driver);
  const snapshot: ProviderQuotaSnapshot = {
    instanceId,
    driver,
    status: "current",
    source: "test",
    readAt: "2026-08-12T00:00:00.000Z",
    lastSuccessfulReadAt: "2026-08-12T00:00:00.000Z",
    headlineMetricKey: "headline",
    metrics: [
      {
        key: "headline",
        label: input.metricLabel,
        remainingPercent: input.percentage,
        usedPercent: input.percentage === null ? null : 100 - input.percentage,
        resetsAt: "2026-08-17T00:00:00.000Z",
        windowMinutes: 300,
        blocking: true,
      },
    ],
    credits: null,
    bankedResets: null,
    detail: {},
    message: null,
  };
  return {
    instanceId,
    driver,
    displayName: input.displayName,
    percentage: input.percentage,
    headlineLabel: input.percentage === null ? null : input.metricLabel,
    snapshot,
  };
}

const codexItem = item({
  id: "codex-work",
  driver: "codex",
  displayName: "Work Codex",
  percentage: 64,
  metricLabel: "Weekly limit",
});
const claudeItem = item({
  id: "claude-personal",
  driver: "claudeAgent",
  displayName: "Personal Claude",
  percentage: 82,
  metricLabel: "Five-hour limit",
});

describe("ProviderQuotaSectionView", () => {
  it("renders settings-ordered logo percentages and details for only the selected provider", () => {
    const markup = renderToStaticMarkup(
      <ProviderQuotaSectionView
        canOperate={false}
        items={[codexItem, claudeItem]}
        onConsumeReset={async () => null}
        onSelect={() => {}}
        selectedItem={claudeItem}
      />,
    );

    expect(markup).toContain('id="provider-limits"');
    expect(markup).toContain("Usage limits");
    expect(markup.indexOf("Work Codex")).toBeLessThan(markup.indexOf("Personal Claude"));
    expect(markup).toContain(">64%</span>");
    expect(markup).toContain(">82%</span>");
    expect(markup.match(/aria-pressed="true"/gu)).toHaveLength(1);
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("Five-hour limit");
    expect(markup).not.toContain("Weekly limit");
  });

  it("renders unavailable percentages honestly without dropping the provider selector", () => {
    const unavailable = { ...codexItem, percentage: null, headlineLabel: null, snapshot: null };
    const markup = renderToStaticMarkup(
      <ProviderQuotaSectionView
        canOperate={false}
        items={[unavailable]}
        onConsumeReset={async () => null}
        onSelect={() => {}}
        selectedItem={unavailable}
      />,
    );

    expect(markup).toContain("Work Codex");
    expect(markup).toContain(">—</span>");
    expect(markup).toContain("does not provide normalized quota details");
  });

  it("omits the live-limits section when no visible provider is configured", () => {
    expect(
      renderToStaticMarkup(
        <ProviderQuotaSectionView
          canOperate={false}
          items={[]}
          onConsumeReset={async () => null}
          onSelect={() => {}}
          selectedItem={null}
        />,
      ),
    ).toBe("");
  });
});

describe("prepareProviderResetConsumption", () => {
  const nativeRandomUuid = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");

  afterEach(() => {
    if (nativeRandomUuid === undefined) {
      delete (globalThis.crypto as { randomUUID?: () => string }).randomUUID;
    } else {
      Object.defineProperty(globalThis.crypto, "randomUUID", nativeRandomUuid);
    }
  });

  it("builds a valid request when native crypto.randomUUID is unavailable", () => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });

    const prepared = prepareProviderResetConsumption({
      attempt: { idempotencyKey: null, pending: false, feedback: null },
      instanceId: ProviderInstanceId.make("codex-work"),
      creditId: "credit-1",
    });

    expect(prepared.input).toMatchObject({
      instanceId: ProviderInstanceId.make("codex-work"),
      creditId: "credit-1",
    });
    expect(prepared.input.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("reuses a failed attempt for the same credit and changes keys for another credit", () => {
    const first = prepareProviderResetConsumption({
      attempt: { idempotencyKey: null, pending: false, feedback: null },
      instanceId: ProviderInstanceId.make("codex-work"),
      creditId: "credit-1",
    });
    const failedAttempt = { ...first.attempt, pending: false, feedback: "Offline" };
    const sameCredit = prepareProviderResetConsumption({
      attempt: failedAttempt,
      instanceId: ProviderInstanceId.make("codex-work"),
      creditId: "credit-1",
    });
    const otherCredit = prepareProviderResetConsumption({
      attempt: failedAttempt,
      instanceId: ProviderInstanceId.make("codex-work"),
      creditId: "credit-2",
    });

    expect(sameCredit.input.idempotencyKey).toBe(first.input.idempotencyKey);
    expect(otherCredit.input.idempotencyKey).not.toBe(first.input.idempotencyKey);
  });
});
