import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { ProviderInstanceCard } from "./ProviderInstanceCard";

import "../../index.css";

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
  vi.useRealTimers();
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

function pauseBlur(toggle: HTMLButtonElement) {
  const transition = toggle
    .getAnimations()
    .find(
      (animation) =>
        animation instanceof CSSTransition && animation.transitionProperty === "filter",
    );
  expect(transition).toBeDefined();
  transition!.pause();
  transition!.currentTime = Number(transition!.effect!.getComputedTiming().duration) / 2;
  return transition!;
}

describe("ProviderInstanceCard", () => {
  it("blurs the revealed email before replacing it with the placeholder", async () => {
    await renderCard(
      provider({ auth: { status: "authenticated", email: "developer@example.com" } }),
      "editor",
    );
    expect(container.textContent).toContain("Authenticated as");
    expect(container.textContent).not.toContain("developer@example.com");

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle account email visibility"]',
    )!;
    const placeholder = toggle.textContent;
    const hiddenFilter = getComputedStyle(toggle).filter;
    await act(() => userEvent.click(toggle));
    await act(async () =>
      Promise.all(toggle.getAnimations().map((animation) => animation.finished)),
    );
    expect(toggle.textContent).toBe("developer@example.com");
    const revealedFilter = getComputedStyle(toggle).filter;

    // A synchronous click lets us inspect the real CSS transition before the next paint.
    await act(() => toggle.click());
    const blur = pauseBlur(toggle);
    expect(getComputedStyle(toggle).filter).not.toBe(revealedFilter);
    expect(getComputedStyle(toggle).filter).not.toBe(hiddenFilter);
    expect(toggle.textContent).toBe("developer@example.com");

    const transitionEnd = new Promise<TransitionEvent>((resolve) =>
      toggle.addEventListener("transitionend", resolve, { once: true }),
    );
    await act(async () => {
      blur.finish();
      await transitionEnd;
    });
    expect(toggle.textContent).toBe(placeholder);
    expect(getComputedStyle(toggle).filter).toBe(hiddenFilter);
  });

  it("keeps a later hide intact after revealing during a theme-interrupted hide", async () => {
    await renderCard(
      provider({ auth: { status: "authenticated", email: "developer@example.com" } }),
      "editor",
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle account email visibility"]',
    )!;
    const placeholder = toggle.textContent;
    const hiddenFilter = getComputedStyle(toggle).filter;
    await act(() => userEvent.click(toggle));
    await act(async () =>
      Promise.all(toggle.getAnimations().map((animation) => animation.finished)),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    container.classList.add("no-transitions");
    await act(() => toggle.click());
    expect(getComputedStyle(toggle).filter).toBe(hiddenFilter);
    await act(() => vi.advanceTimersByTime(300));

    await act(() => toggle.click());
    expect(toggle.textContent).toBe("developer@example.com");
    expect(getComputedStyle(toggle).filter).not.toBe(hiddenFilter);
    await act(() => vi.advanceTimersByTime(50));
    container.classList.remove("no-transitions");
    expect(getComputedStyle(toggle).filter).not.toBe(hiddenFilter);

    await act(() => toggle.click());
    const blur = pauseBlur(toggle);
    // Cross the first hide's fallback deadline while the second blur is still incomplete.
    await act(() => vi.advanceTimersByTime(50));
    expect(getComputedStyle(toggle).filter).not.toBe(hiddenFilter);
    expect(toggle.textContent).toBe("developer@example.com");

    // A canceled transition has no transitionend event to finish the hide.
    blur.cancel();
    expect(getComputedStyle(toggle).filter).toBe(hiddenFilter);
    await act(() => vi.advanceTimersByTime(1_000));
    expect(toggle.textContent).toBe(placeholder);
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
