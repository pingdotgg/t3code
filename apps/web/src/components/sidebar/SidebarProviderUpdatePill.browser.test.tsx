import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";

const state = vi.hoisted(() => ({ providers: [] as ServerProvider[] }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.providers,
}));
vi.mock("../../state/server", () => ({ primaryServerProvidersAtom: {} }));

const checkedAt = "2026-10-19T03:00:00.000Z";

function provider(status: "running" | "succeeded" | "failed"): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "2.1.303",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    updateState: {
      status,
      startedAt: checkedAt,
      finishedAt: status === "running" ? null : "2026-10-19T04:00:00.000Z",
      message: status === "failed" ? "Update failed." : "Provider updated.",
      output: null,
    },
  };
}

function setup(providers: ServerProvider[]) {
  state.providers = providers;
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

// Fake timers move past the exit before any real transitionend can fire, like a skipped or
// cancelled transition in the app.
describe("SidebarProviderUpdatePill exit", () => {
  it("replaces a finished update's spinner with success, then dismisses it", async () => {
    setup([provider("running")]);
    await using screen = await render(<SidebarProviderUpdatePill />);
    using _timers = fakeTimers();
    expect(screen.container.querySelector('[role="status"]')).not.toBeNull();

    setup([provider("succeeded")]);
    await screen.rerender(<SidebarProviderUpdatePill />);
    await advance(180);
    expect(screen.container.textContent).toContain("Claude updated: v2.1.303");
    expect(screen.container.querySelector('[role="status"]')).toBeNull();

    await advance(3_000);
    await advance(180);
    expect(screen.container.textContent).toBe("");
  });

  it("removes a dismissed failure", async () => {
    setup([provider("failed")]);
    await using screen = await render(<SidebarProviderUpdatePill />);
    using _timers = fakeTimers();
    expect(screen.container.textContent).toContain("Claude update failed");

    await act(() =>
      screen.container
        .querySelector<HTMLButtonElement>('[aria-label="Dismiss provider update notice"]')
        ?.click(),
    );
    await advance(180);
    expect(screen.container.textContent).toBe("");
  });
});
