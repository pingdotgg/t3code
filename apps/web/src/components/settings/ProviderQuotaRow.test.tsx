import type { ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderQuotaRow } from "./ProviderQuotaRow.tsx";

function provider(auth: ServerProvider["auth"]): ServerProvider {
  return {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth,
    checkedAt: "2026-08-01T11:59:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

describe("ProviderQuotaRow", () => {
  it("renders nothing for a snapshot from a server without increment 2", () => {
    expect(renderToStaticMarkup(<ProviderQuotaRow provider={null} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <ProviderQuotaRow
          provider={provider({ status: "authenticated", label: "ChatGPT Pro Subscription" })}
        />,
      ),
    ).toBe("");
  });

  it("renders the plan chip, a meter and the usage line when quota arrived", () => {
    const markup = renderToStaticMarkup(
      <ProviderQuotaRow
        provider={provider({
          status: "authenticated",
          planType: "pro",
          rateLimits: {
            checkedAt: "2026-08-01T11:59:00.000Z",
            primary: { usedPercent: 37, windowMinutes: 300 },
          },
          usage: { lifetimeTokens: 5_000_000 },
        })}
      />,
    );
    expect(markup).toContain("Pro");
    expect(markup).toContain("5h limit");
    expect(markup).toContain('aria-valuenow="37"');
    expect(markup).toContain("37%");
    expect(markup).toContain("5.0M lifetime");
  });

  it("shows the limit-reached notice", () => {
    const markup = renderToStaticMarkup(
      <ProviderQuotaRow
        provider={provider({
          status: "authenticated",
          rateLimits: {
            checkedAt: "2026-08-01T11:59:00.000Z",
            limitReached: true,
            primary: { usedPercent: 100 },
          },
        })}
      />,
    );
    expect(markup).toContain("Usage limit reached");
  });
});
