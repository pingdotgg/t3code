import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { ProviderInstanceCard } from "./ProviderInstanceCard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

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
  await act(async () =>
    root.render(
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
    ),
  );
}

describe("ProviderInstanceCard", () => {
  it("hides the account email until the user reveals it, and hides it again", async () => {
    await renderCard(
      provider({ auth: { status: "authenticated", email: "developer@example.com" } }),
      "editor",
    );
    expect(container.textContent).toContain("Authenticated as");
    expect(container.textContent).not.toContain("developer@example.com");

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle account email visibility"]',
    )!;
    await userEvent.click(toggle);
    expect(toggle.textContent).toBe("developer@example.com");

    await userEvent.click(toggle);
    expect(container.textContent).not.toContain("developer@example.com");
  });

  it.each(["list", "editor"] as const)(
    "surfaces a failed probe message in the %s",
    async (mode) => {
      await renderCard(
        provider({
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message:
            "Codex app-server provider probe failed: Cannot create Codex shadow home entry 'auth.json' because '/home/me/.codex-t3/work/auth.json' already exists and is not a symlink.",
        }),
        mode,
      );
      expect(container.textContent).toContain("Unavailable");
      expect(container.textContent).toContain("is not a symlink");
    },
  );
});
