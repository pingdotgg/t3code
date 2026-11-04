import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { QuickUsagePopover } from "./QuickUsagePopover";

import type { EnvironmentPresentationWithProviders } from "@t3tools/client-runtime/state/presentation";

const presentationsState = vi.hoisted(() => ({
  value: new Map() as ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>,
}));
const refreshCommand = vi.hoisted(() => ({ action: vi.fn() }));

vi.mock(import("../../state/presentation"), async (original) => ({
  ...(await original()),
  environmentPresentations: {
    ...(await original()).environmentPresentations,
    presentationsWithProvidersAtom: Atom.make(() => presentationsState.value),
  },
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => refreshCommand.action) as never,
}));

const checkedAt = "2026-10-25T16:00:00.000Z";

function provider(
  driver: string,
  usedPercent: { session: number; weekly: number },
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(`${driver}-1`),
    driver: ProviderDriverKind.make(driver),
    displayName: driver,
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: `${driver}-session`,
          kind: "session",
          label: "Session",
          usedPercent: usedPercent.session,
          resetsAt: "2026-10-25T19:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: `${driver}-weekly`,
          kind: "weekly",
          label: "Weekly",
          usedPercent: usedPercent.weekly,
          resetsAt: "2026-10-26T16:00:00.000Z",
          windowDurationMins: 10080,
        },
      ],
    },
  } as unknown as ServerProvider;
}

function unavailableProvider(): ServerProvider {
  return {
    ...provider("cursor", { session: 0, weekly: 0 }),
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed", message: "Could not read limits." },
    },
  } as unknown as ServerProvider;
}

function setup(presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>) {
  presentationsState.value = presentations;
  refreshCommand.action.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  const registry = AtomRegistry.make();
  return { registry };
}

function view(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>,
  onOpenFull?: () => void,
) {
  const { registry } = setup(presentations);
  return (
    <RegistryContext value={registry}>
      {onOpenFull === undefined ? (
        <QuickUsagePopover />
      ) : (
        <QuickUsagePopover onOpenFull={onOpenFull} />
      )}
    </RegistryContext>
  );
}

function envPresentations(providers: ServerProvider[]) {
  return new Map<EnvironmentId, EnvironmentPresentationWithProviders>([
    [
      EnvironmentId.make("env-1"),
      {
        entry: { target: { label: "Desk" } },
        connection: { phase: "connected", error: null, traceId: null },
        serverConfig: { providers: [...providers] },
      } as unknown as EnvironmentPresentationWithProviders,
    ],
  ]);
}

describe("QuickUsagePopover", () => {
  it("defaults to the tightest provider (Claude over Codex)", async () => {
    const presentations = envPresentations([
      provider("codex", { session: 22, weekly: 42 }),
      provider("claudeAgent", { session: 58, weekly: 47 }),
      unavailableProvider(),
    ]);
    await using screen = await render(view(presentations));

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    await expect.element(page.getByRole("button", { name: "Codex" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Claude Code" })).toBeVisible();
    // Claude min remaining (42%) is tighter than Codex (58% weekly), so Claude is selected by default; Codex session 78% stays hidden.
    await expect.element(page.getByText("42% left", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Claude Code", pressed: true }))
      .toBeVisible();
    await expect.element(page.getByText("Session", { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cursor" }));
    await expect.element(page.getByText("Could not read limits.")).toBeVisible();
  });

  it("clicking Codex swaps windows to Codex", async () => {
    const presentations = envPresentations([
      provider("codex", { session: 22, weekly: 42 }),
      provider("claudeAgent", { session: 58, weekly: 47 }),
    ]);
    await using screen = await render(view(presentations));

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    await expect.element(page.getByText("42% left", { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Codex" }));
    await expect.element(page.getByRole("button", { name: "Codex", pressed: true })).toBeVisible();
    await expect.element(page.getByText("78% left", { exact: true })).toBeVisible();
  });

  it("shows empty state when no provider has limits", async () => {
    const presentations = envPresentations([]);
    await using screen = await render(view(presentations));

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    await expect.element(page.getByText("No usage limits reported yet.")).toBeVisible();
  });

  it("shows refresh progress while refreshing connected provider limits", async () => {
    const presentations = envPresentations([provider("codex", { session: 22, weekly: 42 })]);
    let finishRefresh: (() => void) | undefined;
    const element = view(presentations);
    refreshCommand.action.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRefresh = () => resolve({ _tag: "Success", value: {} });
        }),
    );
    await using screen = await render(element);

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    const refreshButton = page.getByRole("button", { name: "Refresh usage" });
    await userEvent.click(refreshButton);
    await expect.element(refreshButton).toBeDisabled();
    expect(refreshCommand.action).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env-1"),
      input: {},
    });

    finishRefresh?.();
    await expect.element(refreshButton).not.toBeDisabled();
  });
});
