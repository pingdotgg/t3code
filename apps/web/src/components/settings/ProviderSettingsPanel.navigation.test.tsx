import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type UnifiedSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import * as Data from "effect/Data";
import * as Exit from "effect/Exit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  save: vi.fn(),
  providers: [] as ServerProvider[],
  toast: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => Symbol("providers"),
    refreshProviders: Symbol("refresh"),
    updateProvider: Symbol("update"),
    updateSettings: Symbol("settings"),
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
// Tooltip positioning needs a browser; it does not participate in account navigation.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => state.settings,
  useUpdateEnvironmentSettings: () => vi.fn(),
  useUpdateClientSettings: () => vi.fn(),
  usePrimarySettingsAvailable: () => true,
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (value: unknown) => value,
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("navigation-test");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");
class SaveError extends Data.TaggedError("SaveError")<{ readonly message: string }> {}
const claudeId = ProviderInstanceId.make("claudeAgent");
let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [codexId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      [claudeId]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
    },
  };
  state.providers = [];
  state.toast.mockReset();
  state.save.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function mountPanel(
  targetInstanceId?: ProviderInstanceId,
  createNodeMock?: (element: ReactElement) => unknown,
) {
  await act(() => {
    renderer = create(
      <EnvironmentProviderSettings
        environmentId={environmentId}
        environmentLabel="Test device"
        view={{ value: "accounts", onValueChange: vi.fn() }}
        targetInstanceId={targetInstanceId}
      />,
      createNodeMock ? { createNodeMock } : undefined,
    );
  });
}

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}
function heading() {
  return renderer.root
    .findAllByType("h2")
    .map(textContent)
    .find((text) => text.includes(" /"));
}
function buttonByLabel(label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === label || textContent(node) === label);
  if (!button) throw new Error(`Button missing: ${label}`);
  return button;
}
async function clickButton(label: string) {
  await act(async () => {
    await buttonByLabel(label).props.onClick();
  });
}
function startDeletion() {
  let deleting!: Promise<void>;
  act(() => {
    deleting = buttonByLabel(`Delete instance ${customId}`).props.onClick();
  });
  return deleting;
}
function withCustomAccount() {
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [customId]: { driver: ProviderDriverKind.make("codex"), enabled: true, displayName: "Work" },
    },
  };
}

describe("provider account navigation", () => {
  it("starts with an enabled account while preserving explicit disabled targets", async () => {
    await mountPanel();
    expect(heading()).toBe("Claude /Default");
    await act(() => renderer.unmount());
    await mountPanel(codexId);
    expect(heading()).toBe("Codex /Default");
  });

  it("shows a missing deep link without substituting another account", async () => {
    await mountPanel(customId);
    expect(heading()).toBeUndefined();
    expect(textContent(renderer.root)).toContain("This provider instance is no longer available");
  });

  it("returns from a deleted account only after saving, before the settings stream catches up", async () => {
    withCustomAccount();
    let resolveSave!: (result: Exit.Exit<void>) => void;
    const pending = new Promise<Exit.Exit<void>>((resolve) => {
      resolveSave = resolve;
    });
    state.save.mockReturnValue(pending);
    await mountPanel(customId);
    const deleting = startDeletion();
    expect(heading()).toBe("Codex /Work");
    await act(async () => {
      resolveSave(Exit.succeed(undefined));
      await deleting;
    });
    expect(heading()).toBe("Codex /Default");
    // The stored snapshot deliberately still contains the removed account.
    expect(state.settings?.providerInstances[customId]).toBeDefined();
    expect(state.save).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { patch: { providerInstances: {} } },
    });
  });

  it("keeps the selected account available after a failed deletion", async () => {
    withCustomAccount();
    state.save.mockResolvedValue(Exit.fail(new SaveError({ message: "Device disconnected" })));
    await mountPanel(customId);
    await clickButton(`Delete instance ${customId}`);
    expect(heading()).toBe("Codex /Work");
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "Device disconnected" }),
    );
  });

  it("preserves navigation to another account while deletion is pending", async () => {
    withCustomAccount();
    let resolveSave!: (result: Exit.Exit<void>) => void;
    const pending = new Promise<Exit.Exit<void>>((resolve) => {
      resolveSave = resolve;
    });
    state.save.mockReturnValue(pending);
    await mountPanel(customId);
    const deleting = startDeletion();
    await clickButton("Select Claude account Default");
    await act(async () => {
      resolveSave(Exit.succeed(undefined));
      await deleting;
    });
    expect(heading()).toBe("Claude /Default");
  });

  it.each([true, false])(
    "restores Back focus when the selected row is visible: %s",
    async (visible) => {
      const row = { checkVisibility: () => visible, focus: vi.fn(), scrollIntoView: vi.fn() };
      const filter = { checkVisibility: () => true, focus: vi.fn(), scrollIntoView: vi.fn() };
      await mountPanel(codexId, ({ type }) =>
        type === "nav"
          ? {
              querySelector: (selector: string) => (selector.startsWith("button") ? row : filter),
            }
          : null,
      );
      await clickButton("All accounts");
      expect((visible ? row : filter).focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect((visible ? filter : row).focus).not.toHaveBeenCalled();
    },
  );

  it.each(["error", "warning"] as const)(
    "shows %s status alongside the authenticated account",
    async (status) => {
      state.providers = [
        {
          instanceId: claudeId,
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          installed: true,
          version: null,
          status,
          auth: { status: "authenticated", email: "test@example.com" },
          checkedAt: "2026-09-10T12:00:00Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ];
      await mountPanel();
      const editorStatus = renderer.root
        .findAllByType("span")
        .find((node) => textContent(node) === "Authenticated as")?.parent;
      if (!editorStatus) throw new Error("Editor status missing");
      expect(textContent(editorStatus)).toContain(
        status === "error" ? "Unavailable" : "Needs attention",
      );
      expect(textContent(editorStatus)).toContain("Authenticated as");
    },
  );

  it.each([
    {
      installed: false,
      auth: { status: "authenticated" },
      headline: "Not found",
      dot: "bg-destructive",
    },
    {
      installed: true,
      auth: { status: "unauthenticated" },
      headline: "Not authenticated",
      dot: "bg-warning",
    },
  ] as const)(
    "shows $headline with a non-ready dot despite a ready server status",
    async ({ installed, auth, headline, dot }) => {
      state.providers = [
        {
          instanceId: claudeId,
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          installed,
          version: null,
          status: "ready",
          auth,
          checkedAt: "2026-09-10T12:00:00Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ];
      await mountPanel();
      const row = buttonByLabel("Select Claude account Default");
      expect(textContent(row)).toContain(headline);
      const statusDot = row
        .findAllByType("span")
        .find((node) => node.props["aria-hidden"] === true);
      expect(statusDot?.props.className).toContain(dot);
    },
  );
});
