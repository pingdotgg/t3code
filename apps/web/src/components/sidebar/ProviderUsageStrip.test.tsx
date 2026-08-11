import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProviderUsageStripItem } from "./ProviderUsageStrip.logic";
import {
  providerUsageTooltip,
  ProviderUsageStrip,
  ProviderUsageStripView,
} from "./ProviderUsageStrip";
import { SidebarMenu, SidebarMenuItem } from "../ui/sidebar";

const mocks = vi.hoisted(() => ({
  primaryEnvironment: null as {
    readonly serverConfig: {
      readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId">>;
      readonly settings: ServerSettings;
    } | null;
  } | null,
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => mocks.primaryEnvironment,
}));
vi.mock("../../state/providerQuota", () => ({
  usePrimaryProviderQuota: () => ({
    summary: null,
    isPending: false,
    error: null,
    refresh: () => {},
    consumeReset: async () => null,
  }),
}));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false }),
}));

function item(input: {
  readonly id: string;
  readonly percentage: number | null;
}): ProviderUsageStripItem {
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driver: ProviderDriverKind.make("codex"),
    displayName: input.id === "codex-work" ? "Work Codex" : "Personal Codex",
    percentage: input.percentage,
    headlineLabel: input.percentage === null ? null : "Weekly limit",
    snapshot: null,
  };
}

describe("ProviderUsageStripView", () => {
  it("renders a stable one-line logo/value strip without visible provider names or headings", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageStripView
        items={[
          item({ id: "codex-personal", percentage: 100 }),
          item({ id: "codex-work", percentage: null }),
        ]}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain(">100%</span>");
    expect(markup).toContain(">—</span>");
    expect(markup).toContain("tabular-nums");
    expect(markup.match(/<svg/g)).toHaveLength(2);
    expect(markup).not.toContain(">Personal Codex<");
    expect(markup).not.toContain(">Work Codex<");
    expect(markup).not.toContain("Provider usage");
  });

  it("labels available and unavailable buttons with the instance and window", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageStripView
        items={[
          item({ id: "codex-personal", percentage: 100 }),
          item({ id: "codex-work", percentage: null }),
        ]}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Personal Codex: 100% remaining, Weekly limit"');
    expect(markup).toContain('aria-label="Work Codex: usage remaining unavailable"');
  });

  it("formats the last successful read consistently in the tooltip", () => {
    const value = "2026-08-11T08:00:00.000Z";
    const withSnapshot = {
      ...item({ id: "codex-personal", percentage: 100 }),
      snapshot: {
        instanceId: ProviderInstanceId.make("codex-personal"),
        driver: ProviderDriverKind.make("codex"),
        status: "current" as const,
        source: "test",
        readAt: value,
        lastSuccessfulReadAt: value,
        headlineMetricKey: null,
        metrics: [],
        credits: null,
        bankedResets: null,
        detail: {},
        message: null,
      },
    };

    expect(providerUsageTooltip(withSnapshot)).toContain(new Date(value).toLocaleString());
    expect(providerUsageTooltip(withSnapshot)).not.toContain(value);
  });

  it("keeps provider indicators navigation-only instead of opening a competing detail overlay", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageStripView
        items={[item({ id: "codex-personal", percentage: 100 })]}
        onSelect={() => {}}
      />,
    );

    expect(markup).not.toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain('data-base-ui-click-trigger=""');
    expect(markup).not.toContain('data-slot="popover-popup"');
    expect(markup).not.toContain('data-slot="sheet-popup"');
  });

  it("keeps every footer menu child semantic and places the strip before Usage", () => {
    const markup = renderToStaticMarkup(
      <SidebarMenu data-testid="footer-menu">
        <ProviderUsageStripView
          items={[item({ id: "codex-personal", percentage: 100 })]}
          onSelect={() => {}}
        />
        <SidebarMenuItem>Usage</SidebarMenuItem>
      </SidebarMenu>,
    );
    const menuContent = markup.match(/<ul[^>]*data-testid="footer-menu"[^>]*>(.*)<\/ul>/u)?.[1];
    const directListItems = menuContent?.match(/<li\b[\s\S]*?<\/li>/gu) ?? [];

    expect(menuContent).toBeDefined();
    expect(directListItems).toHaveLength(2);
    expect(directListItems.join("")).toBe(menuContent);
    expect(menuContent?.indexOf('data-slot="provider-usage-strip"')).toBeLessThan(
      menuContent?.indexOf("Usage") ?? -1,
    );
  });
});

describe("ProviderUsageStrip", () => {
  const codexWorkId = ProviderInstanceId.make("codex-work");
  const codexConfig = {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [codexWorkId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Work Codex",
          enabled: true,
        },
      },
    },
    providers: [{ instanceId: codexWorkId }],
  } satisfies {
    readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId">>;
    readonly settings: ServerSettings;
  };

  beforeEach(() => {
    mocks.primaryEnvironment = null;
  });

  it("does not build default provider rows before a primary environment exists", () => {
    expect(renderToStaticMarkup(<ProviderUsageStrip onSelect={() => {}} />)).not.toContain(
      'data-slot="provider-usage-strip"',
    );
  });

  it("does not build provider rows while the primary config is loading", () => {
    mocks.primaryEnvironment = { serverConfig: null };

    expect(renderToStaticMarkup(<ProviderUsageStrip onSelect={() => {}} />)).not.toContain(
      'data-slot="provider-usage-strip"',
    );
  });

  it("builds provider rows from the real primary config", () => {
    mocks.primaryEnvironment = { serverConfig: codexConfig };

    expect(renderToStaticMarkup(<ProviderUsageStrip onSelect={() => {}} />)).toContain(
      'aria-label="Work Codex: usage remaining unavailable"',
    );
  });
});
