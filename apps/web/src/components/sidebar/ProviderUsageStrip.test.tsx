import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProviderUsageStripItem } from "./ProviderUsageStrip.logic";
import {
  prepareProviderResetConsumption,
  ProviderUsageStrip,
  ProviderUsageStripView,
} from "./ProviderUsageStrip";
import { SidebarMenu, SidebarMenuItem } from "../ui/sidebar";

const mocks = vi.hoisted(() => ({
  primaryEnvironment: null as { readonly serverConfig: ServerConfig | null } | null,
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
        canOperate={false}
        isSmallScreen={false}
        items={[
          item({ id: "codex-personal", percentage: 100 }),
          item({ id: "codex-work", percentage: null }),
        ]}
        onConsumeReset={async () => null}
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
        canOperate={false}
        isSmallScreen
        items={[
          item({ id: "codex-personal", percentage: 100 }),
          item({ id: "codex-work", percentage: null }),
        ]}
        onConsumeReset={async () => null}
      />,
    );

    expect(markup).toContain('aria-label="Personal Codex: 100% remaining, Weekly limit"');
    expect(markup).toContain('aria-label="Work Codex: usage remaining unavailable"');
  });

  it("keeps every footer menu child semantic and places the strip before Usage", () => {
    const markup = renderToStaticMarkup(
      <SidebarMenu data-testid="footer-menu">
        <ProviderUsageStripView
          canOperate={false}
          isSmallScreen={false}
          items={[item({ id: "codex-personal", percentage: 100 })]}
          onConsumeReset={async () => null}
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
  const codexConfig = {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        "codex-work": {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Work Codex",
          enabled: true,
        },
      },
    },
    providers: [{ instanceId: ProviderInstanceId.make("codex-work") }],
  } as unknown as ServerConfig;

  beforeEach(() => {
    mocks.primaryEnvironment = null;
  });

  it("does not build default provider rows before a primary environment exists", () => {
    expect(renderToStaticMarkup(<ProviderUsageStrip />)).not.toContain(
      'data-slot="provider-usage-strip"',
    );
  });

  it("does not build provider rows while the primary config is loading", () => {
    mocks.primaryEnvironment = { serverConfig: null };

    expect(renderToStaticMarkup(<ProviderUsageStrip />)).not.toContain(
      'data-slot="provider-usage-strip"',
    );
  });

  it("builds provider rows from the real primary config", () => {
    mocks.primaryEnvironment = { serverConfig: codexConfig };

    expect(renderToStaticMarkup(<ProviderUsageStrip />)).toContain(
      'aria-label="Work Codex: usage remaining unavailable"',
    );
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

  it("builds a valid consume request when native crypto.randomUUID is unavailable", () => {
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
    expect(prepared.attempt).toEqual({
      idempotencyKey: prepared.input.idempotencyKey,
      pending: true,
      feedback: null,
    });
  });
});
