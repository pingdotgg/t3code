import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ProviderInstanceCard } from "./ProviderInstanceCard";

const driver = ProviderDriverKind.make("codex");

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-27T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

async function renderCard(
  liveProvider: ServerProvider,
  mode: ComponentProps<typeof ProviderInstanceCard>["mode"],
) {
  return render(
    <ProviderInstanceCard
      instanceId={liveProvider.instanceId}
      instance={{ driver }}
      driverOption={undefined}
      liveProvider={liveProvider}
      mode={mode}
      onUpdate={() => undefined}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onHiddenModelsChange={() => undefined}
      onFavoriteModelsChange={() => undefined}
      onToggleFavorite={() => undefined}
      onModelOrderChange={() => undefined}
    />,
  );
}

describe("ProviderInstanceCard", () => {
  it("hides the account email until the user reveals it, and hides it again", async () => {
    await using screen = await renderCard(
      provider({ auth: { status: "authenticated", email: "developer@example.com" } }),
      "editor",
    );
    expect(screen.container.textContent).toContain("Authenticated as");
    expect(screen.container.textContent).not.toContain("developer@example.com");

    const toggle = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle account email visibility"]',
    )!;
    await userEvent.click(toggle);
    expect(toggle.textContent).toBe("developer@example.com");

    await userEvent.click(toggle);
    expect(screen.container.textContent).not.toContain("developer@example.com");
  });

  it.each(["list", "editor"] as const)(
    "surfaces a failed probe message in the %s",
    async (mode) => {
      await using screen = await renderCard(
        provider({
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message:
            "Codex app-server provider probe failed: Cannot create Codex shadow home entry 'auth.json' because '/home/me/.codex-t3/work/auth.json' already exists and is not a symlink.",
        }),
        mode,
      );
      expect(screen.container.textContent).toContain("Unavailable");
      expect(screen.container.textContent).toContain("is not a symlink");
    },
  );
});
