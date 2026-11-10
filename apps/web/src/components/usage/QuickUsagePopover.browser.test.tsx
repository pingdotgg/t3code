import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { QuickUsagePopover } from "./QuickUsagePopover";

import type { EnvironmentPresentationWithProviders } from "@t3tools/client-runtime/state/presentation";

const presentationsState = vi.hoisted(() => ({
  value: new Map() as ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>,
}));
const usageState = vi.hoisted(() => ({ value: undefined as unknown }));
const refreshCommand = vi.hoisted(() => ({ action: vi.fn() }));
const refreshUsageMock = vi.hoisted(() => ({ action: vi.fn() }));
const toastMock = vi.hoisted(() => ({ add: vi.fn() }));

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

vi.mock(import("../../state/usage"), () => ({
  useUsage: (() => usageState.value) as never,
}));

vi.mock(import("../ui/toast"), async (original) => {
  const module = await original();
  return {
    ...module,
    toastManager: { ...module.toastManager, add: toastMock.add },
  };
});

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

function unavailableProvider(message = "Could not read limits."): ServerProvider {
  return {
    ...provider("cursor", { session: 0, weekly: 0 }),
    displayName: undefined,
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed", message },
    },
  } as unknown as ServerProvider;
}

function environmentPresentation(
  providers: ServerProvider[],
  label: string,
): EnvironmentPresentationWithProviders {
  return {
    entry: { target: { label } },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: { providers: [...providers] },
  } as unknown as EnvironmentPresentationWithProviders;
}

function setup(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>,
  usage: unknown = { shown: null, merged: { daily: [] }, selectedEnvironments: [] },
) {
  presentationsState.value = presentations;
  usageState.value = {
    shown: null,
    merged: { daily: [] },
    selectedEnvironments: [],
    ...(usage as Record<string, unknown> | undefined),
    refresh: refreshUsageMock.action,
  };
  refreshCommand.action.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  refreshUsageMock.action.mockReset().mockResolvedValue(undefined);
  toastMock.add.mockReset();
  const registry = AtomRegistry.make();
  return { registry };
}

function view(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>,
  onOpenFull?: () => void,
  usage?: unknown,
) {
  const { registry } = setup(presentations, usage);
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
    [EnvironmentId.make("env-1"), environmentPresentation(providers, "Desk")],
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
    const positioner = page
      .getByText("Quick usage")
      .element()
      .closest<HTMLElement>('[data-slot="popover-positioner"]');
    expect(positioner?.getBoundingClientRect().left).toBe(0);
    await userEvent.click(page.getByRole("button", { name: "Cursor" }));
    await expect
      .element(page.getByText("Could not load subscription limits. Refresh to try again."))
      .toBeVisible();
    await userEvent.hover(
      page.getByRole("button", { name: "Subscription limit error details for Desk" }),
    );
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

  it("closes the quick view before opening the full Usage page", async () => {
    const onOpenFull = vi.fn();
    await using screen = await render(
      view(envPresentations([provider("codex", { session: 22, weekly: 42 })]), onOpenFull),
    );

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    await userEvent.click(page.getByRole("button", { name: "View more" }));

    expect(onOpenFull).toHaveBeenCalledOnce();
    await expect.element(page.getByText("Quick usage")).not.toBeInTheDocument();
  });

  it("keeps spend summary and View more available when no provider reports limits", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-25T16:30:00.000Z"));
    const failedCodex = {
      ...provider("codex", { session: 0, weekly: 0 }),
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "Codex could not read usage (JSON-RPC -32600).",
        },
      },
    } as ServerProvider;
    const presentations = envPresentations([failedCodex]);
    const merged = {
      daily: [
        { day: "2026-10-25", costUsd: 1 },
        { day: "2026-10-24", costUsd: 2 },
      ],
    };
    const usage = {
      shown: { window: { timeZone: "UTC" }, merged },
      merged,
      selectedEnvironments: [
        {
          environmentId: EnvironmentId.make("env-1"),
          label: "Desk",
          error: "This environment could not report usage.",
        },
      ],
    };
    const onOpenFull = vi.fn();
    await using screen = await render(view(presentations, onOpenFull, usage));

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    await expect
      .element(page.getByText("Could not load subscription limits. Refresh to try again."))
      .toBeVisible();
    await expect.element(page.getByText("Spent today", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Desk: This environment could not report usage.");
    const refreshButton = page.getByRole("button", { name: "Refresh usage" });
    await userEvent.click(refreshButton);
    await expect.element(refreshButton).not.toBeDisabled();
    expect(refreshUsageMock.action).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByText("Spent today", { exact: true })).toBeVisible();
    const viewMore = page.getByRole("button", { name: "View more" });
    await expect.element(viewMore).toBeVisible();
    await userEvent.click(viewMore);
    expect(onOpenFull).toHaveBeenCalledOnce();
  });

  it("keeps unsupported accounts distinct from failed limit probes", async () => {
    const account = unavailableProvider();
    const unsupported = {
      ...account,
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: { reason: "unsupported", message: "This account has no subscription limits." },
      },
    } as ServerProvider;
    await using screen = await render(view(envPresentations([unsupported])));
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    await expect.element(page.getByText("This account has no subscription limits.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Subscription limit error details for Desk" }))
      .not.toBeInTheDocument();
  });

  it("keeps notice-only accounts distinct across environments", async () => {
    const presentations = new Map<EnvironmentId, EnvironmentPresentationWithProviders>([
      [
        EnvironmentId.make("env-1"),
        environmentPresentation([unavailableProvider("Desk could not read limits.")], "Desk"),
      ],
      [
        EnvironmentId.make("env-2"),
        environmentPresentation([unavailableProvider("Remote could not read limits.")], "Remote"),
      ],
    ]);
    await using screen = await render(view(presentations));

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    await expect.element(page.getByRole("button", { name: "Cursor" })).toBeVisible();
    await userEvent.hover(
      page.getByRole("button", { name: "Subscription limit error details for Desk" }),
    );
    await expect.element(page.getByText("Desk could not read limits.")).toBeVisible();
    await userEvent.hover(
      page.getByRole("button", { name: "Subscription limit error details for Remote" }),
    );
    await expect.element(page.getByText("Remote could not read limits.")).toBeVisible();
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
    expect(refreshUsageMock.action).toHaveBeenCalledTimes(1);
  });

  it("reports ordinary provider refresh failures and still refreshes usage", async () => {
    const presentations = envPresentations([provider("codex", { session: 22, weekly: 42 })]);
    const element = view(presentations);
    refreshCommand.action.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("RPC unavailable"))),
    );
    await using screen = await render(element);

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    const refreshButton = page.getByRole("button", { name: "Refresh usage" });
    await userEvent.click(refreshButton);
    await expect.element(refreshButton).not.toBeDisabled();

    expect(toastMock.add).toHaveBeenCalledWith({
      type: "error",
      title: "Could not refresh usage limits",
      description: "Refresh failed for Desk.",
    });
    expect(refreshUsageMock.action).toHaveBeenCalledTimes(1);
  });

  it("reports provider refresh defects without leaving a rejection", async () => {
    const presentations = envPresentations([provider("codex", { session: 22, weekly: 42 })]);
    const element = view(presentations);
    refreshCommand.action.mockResolvedValue(
      AsyncResult.failure(Cause.die(new Error("Unexpected provider refresh defect"))),
    );
    await using screen = await render(element);

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    const refreshButton = page.getByRole("button", { name: "Refresh usage" });
    await userEvent.click(refreshButton);
    await expect.element(refreshButton).not.toBeDisabled();

    expect(toastMock.add).toHaveBeenCalledWith({
      type: "error",
      title: "Could not refresh usage limits",
      description: "Refresh failed for Desk.",
    });
    expect(refreshUsageMock.action).toHaveBeenCalledTimes(1);
  });
});
