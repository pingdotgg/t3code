import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildEnvironmentUpdateGroups,
  type EnvironmentUpdateGroup,
} from "./ProviderUpdateLaunchNotification.logic";

const testState = vi.hoisted(() => ({
  groups: [] as EnvironmentUpdateGroup[],
  dismissedKeys: new Set<string>(),
  addToast: vi.fn(),
  closeToast: vi.fn(),
  updateToast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

// A saved remote is in the catalog for every test, so the root always picks the
// per-environment flow regardless of whether that remote is connected.
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { entry: { target: { _tag: "PrimaryConnectionTarget" } } },
      { entry: { target: { _tag: "RelayConnectionTarget" } } },
    ],
  }),
}));

vi.mock("../providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: testState.dismissedKeys,
    dismissNotificationKey: vi.fn(),
  }),
}));

vi.mock("./ProviderUpdateEnvironmentRows", () => ({
  ProviderUpdateEnvironmentRows: () => null,
}));

vi.mock("./ProviderUpdateLaunchNotification.environments", () => ({
  useEnvironmentUpdateGroups: () => ({ groups: testState.groups, isAnySettling: false }),
}));

vi.mock("./ProviderUpdatePrimaryNotification", () => ({
  ProviderUpdatePrimaryNotification: () => null,
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: testState.addToast,
    close: testState.closeToast,
    update: testState.updateToast,
  },
}));

import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";

function outdatedProvider(driver: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-26T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: `npm install -g ${driver}@latest`,
      canUpdate: true,
      checkedAt: "2026-06-26T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

/** The groups the popover sees when exactly these environments are connected. */
function connected(...environments: ReadonlyArray<{ id: string; driver: string }>) {
  return buildEnvironmentUpdateGroups(
    environments.map(({ id, driver }) => ({
      environmentId: EnvironmentId.make(id),
      label: id,
      isPrimary: false,
      connectionState: "ready",
      providers: [outdatedProvider(driver)],
    })),
  ).groups;
}

describe("ProviderUpdateLaunchNotification", () => {
  let renderer: ReactTestRenderer | null = null;

  async function render(groups: EnvironmentUpdateGroup[]) {
    testState.groups = groups;
    await act(async () => {
      if (renderer === null) {
        renderer = create(<ProviderUpdateLaunchNotification />);
      } else {
        renderer.update(<ProviderUpdateLaunchNotification />);
      }
    });
  }

  beforeEach(() => {
    testState.dismissedKeys = new Set();
    testState.addToast.mockReset().mockReturnValue("toast-id");
    testState.closeToast.mockReset();
    testState.updateToast.mockReset();
  });

  // Unmounting closes any unanswered prompt, which also forgets that its
  // updates were shown, so the module-level seen set does not leak across tests.
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = null;
  });

  it("keeps the open prompt in place as remotes with updates connect and drop", async () => {
    const primary = { id: "primary", driver: "codex" };
    const remote = { id: "permafrost", driver: "claudeAgent" };

    await render(connected(primary));
    await render(connected(primary, remote));
    await render(connected(primary));

    expect(testState.addToast).toHaveBeenCalledTimes(1);
    expect(testState.closeToast).not.toHaveBeenCalled();
    // The rows are live; only the title has to follow the set on offer.
    expect(testState.updateToast).toHaveBeenCalledTimes(2);
  });

  it("offers a remote's update again after it drops and reconnects unanswered", async () => {
    const remote = { id: "glacier", driver: "codex" };

    await render(connected(remote));
    await render([]);
    expect(testState.closeToast).toHaveBeenCalledWith("toast-id");

    await render(connected(remote));
    expect(testState.addToast).toHaveBeenCalledTimes(2);
  });

  it("prompts again for a remote that dropped before the user dismissed the prompt", async () => {
    const primary = { id: "primary", driver: "codex" };
    const remote = { id: "permafrost", driver: "claudeAgent" };

    await render(connected(primary, remote));
    await render(connected(primary));
    // The user closes the prompt while only the primary's update is on offer.
    testState.addToast.mock.calls[0]![0].data.onClose();

    await render(connected(primary, remote));

    expect(testState.addToast).toHaveBeenCalledTimes(2);
  });

  it("does not re-prompt for a declined update when other remotes come and go", async () => {
    testState.dismissedKeys = new Set(["tundra=codex:1.1.0"]);

    // Declined while another remote was connected; that remote is now offline.
    await render(connected({ id: "tundra", driver: "codex" }));
    expect(testState.addToast).not.toHaveBeenCalled();

    // A different remote with an update the user has not seen still prompts.
    await render(connected({ id: "tundra", driver: "codex" }, { id: "icefield", driver: "codex" }));
    expect(testState.addToast).toHaveBeenCalledTimes(1);
  });
});
