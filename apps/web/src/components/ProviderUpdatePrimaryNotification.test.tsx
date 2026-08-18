// @vitest-environment happy-dom

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  LocalEnvironmentUpdateGroup,
  ProviderUpdateCandidate,
} from "./ProviderUpdateLaunchNotification.logic";

const toast = vi.hoisted(() => ({
  add: vi.fn(() => "provider-update-toast"),
  close: vi.fn(),
  update: vi.fn(),
}));

const providerState = vi.hoisted(() => ({
  hasLocalSecondary: false,
  providers: [] as ServerProvider[],
  groups: [] as LocalEnvironmentUpdateGroup[],
  dismissedKeys: new Set<string>(),
}));

const navigate = vi.hoisted(() => vi.fn());
const updateProvider = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => providerState.providers,
}));

vi.mock("../state/server", () => ({
  primaryServerProvidersAtom: Symbol("providers"),
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: providerState.hasLocalSecondary
      ? [{ entry: { target: { _tag: "BearerConnectionTarget" } } }]
      : [],
  }),
  usePrimaryEnvironment: () => ({ id: "primary" }),
}));

vi.mock("../connection/desktopLocal", () => ({
  isDesktopLocalConnectionTarget: () => providerState.hasLocalSecondary,
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => updateProvider,
}));

vi.mock("../providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: providerState.dismissedKeys,
    dismissNotificationKey: vi.fn(),
  }),
}));

vi.mock("./ProviderUpdateLaunchNotification.environments", () => ({
  useLocalEnvironmentUpdateGroups: () => ({
    groups: providerState.groups,
    isAnySettling: false,
  }),
}));

vi.mock("./ProviderUpdateEnvironmentRows", () => ({
  ProviderUpdateEnvironmentRows: () => null,
}));

vi.mock("./chat/providerIconUtils", () => ({
  PROVIDER_ICON_BY_PROVIDER: {},
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: toast,
}));

import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";

function outdatedClaude(latestVersion: string): ProviderUpdateCandidate {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "2.1.233",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-18T08:03:37.787Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "2.1.233",
      latestVersion,
      updateCommand: "claude update",
      canUpdate: true,
      checkedAt: "2026-08-18T08:03:38.168Z",
      message: "Install the update now or review provider settings.",
    },
  };
}

async function render(component: ReactNode): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StrictMode>{component}</StrictMode>);
  });
  return root;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

describe("provider update notification cleanup", () => {
  const roots: Root[] = [];

  beforeEach(() => {
    document.body.replaceChildren();
    providerState.hasLocalSecondary = false;
    providerState.providers = [];
    providerState.groups = [];
    providerState.dismissedKeys.clear();
    toast.add.mockClear();
    toast.close.mockClear();
    toast.update.mockClear();
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await unmount(root);
    }
  });

  it("keeps the primary prompt open through StrictMode replay and seen after a real unmount", async () => {
    providerState.providers = [outdatedClaude("2.1.234")];

    const firstRoot = await render(<ProviderUpdatePrimaryNotification />);
    roots.push(firstRoot);

    expect(toast.add).toHaveBeenCalledTimes(1);
    expect(toast.close).not.toHaveBeenCalled();

    await unmount(roots.pop()!);
    expect(toast.close).toHaveBeenCalledTimes(1);

    roots.push(await render(<ProviderUpdatePrimaryNotification />));
    expect(toast.add).toHaveBeenCalledTimes(1);
  });

  it("keeps the multi-environment prompt open through replay and seen after unmount", async () => {
    const candidate = outdatedClaude("2.1.235");
    providerState.hasLocalSecondary = true;
    providerState.groups = [
      {
        environmentId: EnvironmentId.make("primary"),
        label: "macOS",
        isPrimary: true,
        isSettling: false,
        candidates: [candidate],
        providers: [candidate],
      },
    ];

    const firstRoot = await render(<ProviderUpdateLaunchNotification />);
    roots.push(firstRoot);

    expect(toast.add).toHaveBeenCalledTimes(1);
    expect(toast.close).not.toHaveBeenCalled();

    await unmount(roots.pop()!);
    expect(toast.close).toHaveBeenCalledTimes(1);

    roots.push(await render(<ProviderUpdateLaunchNotification />));
    expect(toast.add).toHaveBeenCalledTimes(1);
  });
});
