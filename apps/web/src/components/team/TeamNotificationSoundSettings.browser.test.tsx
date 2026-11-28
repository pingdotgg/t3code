import {
  EMPTY_TEAM_ENVIRONMENT_STATE,
  type TeamEnvironmentState,
} from "@t3tools/client-runtime/team";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, TeamId, TeamViewId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
} from "../../hooks/useSettings";
import { NotificationSettings } from "../settings/NotificationSettings";
import { TeamNotificationSoundRow } from "./TeamNotificationSoundSettings";

const envA = EnvironmentId.make("env-team-a");
const envB = EnvironmentId.make("env-team-b");
const teamAId = TeamId.make("team-alpha");
const teamBId = TeamId.make("team-beta");

const makeTeamState = (teamId: TeamId, name: string): TeamEnvironmentState => ({
  ...EMPTY_TEAM_ENVIRONMENT_STATE,
  team: {
    id: teamId,
    name,
    defaultViewId: TeamViewId.make(`view-${teamId}`),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

const mockState = vi.hoisted(() => ({
  teamStates: new Map<EnvironmentId, TeamEnvironmentState>(),
  previewSound: vi.fn(),
  unlockAudio: vi.fn(),
  updateScopedSettings: vi.fn(),
  setClientSettingsError: null as Error | null,
  toastAdd: vi.fn(),
}));

vi.mock(import("../../state/team"), async (original) => ({
  ...(await original()),
  useTeamStatesByEnvironment: () => mockState.teamStates,
}));

vi.mock(import("../../threadNotifications"), async (original) => ({
  ...(await original()),
  previewTeamNotificationSound: mockState.previewSound,
  unlockNotificationAudio: mockState.unlockAudio,
}));

vi.mock(import("../settings/useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector(getClientSettings())) as never,
  useUpdateScopedSettings: () => mockState.updateScopedSettings,
}));

vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: mockState.toastAdd as never,
    },
  };
});

vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: (() => ({
    persistence: {
      getClientSettings: async () => getClientSettings(),
      setClientSettings: async () => {
        if (mockState.setClientSettingsError) {
          throw mockState.setClientSettingsError;
        }
      },
    },
  })) as never,
}));

function setup(
  overrides: {
    readonly teamStates?: ReadonlyArray<readonly [EnvironmentId, TeamEnvironmentState]>;
    readonly notificationMode?: (typeof DEFAULT_CLIENT_SETTINGS)["notificationMode"];
    readonly teamNotificationSounds?: (typeof DEFAULT_CLIENT_SETTINGS)["teamNotificationSounds"];
    readonly setClientSettingsError?: Error | null;
  } = {},
) {
  vi.clearAllMocks();
  mockState.teamStates = new Map(overrides.teamStates ?? []);
  mockState.setClientSettingsError = overrides.setClientSettingsError ?? null;
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    notificationMode: overrides.notificationMode ?? "notifications-and-sound",
    teamNotificationSounds: overrides.teamNotificationSounds ?? {},
  });
  return {
    [Symbol.dispose]() {
      mockState.teamStates = new Map();
      mockState.setClientSettingsError = null;
      __resetClientSettingsPersistenceForTests();
    },
  };
}

describe("TeamNotificationSoundSettings", () => {
  it("renders nothing extra in NotificationSettings when no team is connected (personal mode)", async () => {
    using _env = setup();
    await using screen = await render(<NotificationSettings />);

    await expect.element(screen.getByText("Thread notifications")).toBeVisible();
    expect(screen.getByTestId(`notification-team-sound-select-${teamAId}`).query()).toBeNull();
    expect(screen.getByText("Team notification sounds").query()).toBeNull();
  });

  it("lets users preview and change a connected team's sound preset in NotificationSettings", async () => {
    using _env = setup({
      teamStates: [[envA, makeTeamState(teamAId, "Acme Core")]],
    });

    await using screen = await render(<NotificationSettings />);

    await expect.element(screen.getByText("Team notification sounds")).toBeVisible();
    const trigger = screen.getByTestId(`notification-team-sound-select-${teamAId}`);
    await expect.element(trigger).toHaveTextContent("Chime (Default)");

    // Inline Preview button plays the active preset ("chime") immediately.
    await screen.getByTestId(`notification-team-sound-preview-${teamAId}`).click();
    expect(mockState.previewSound).toHaveBeenCalledWith("chime");

    // Open dropdown, audition "bell" inline without closing, then select "marimba".
    await trigger.click();
    await screen.getByTestId("notification-team-sound-option-preview-bell").click();
    expect(mockState.previewSound).toHaveBeenLastCalledWith("bell");

    await screen.getByTestId("notification-team-sound-option-marimba").click();
    await expect.element(trigger).toHaveTextContent("Marimba");
    expect(getClientSettings().teamNotificationSounds[teamAId]).toBe("marimba");

    // Selecting "off" disables the inline Preview button.
    await trigger.click();
    await screen.getByTestId("notification-team-sound-option-off").click();
    await expect
      .element(screen.getByTestId(`notification-team-sound-preview-${teamAId}`))
      .toBeDisabled();
    expect(getClientSettings().teamNotificationSounds[teamAId]).toBe("off");
  });

  it("renders independent controls per team when multiple teams are connected", async () => {
    using _env = setup({
      teamStates: [
        [envA, makeTeamState(teamAId, "Acme Core")],
        [envB, makeTeamState(teamBId, "Platform Ops")],
      ],
      notificationMode: "sound",
      teamNotificationSounds: { [teamBId]: "pulse" },
    });

    await using screen = await render(<NotificationSettings />);

    await expect.element(screen.getByTestId("notification-team-sounds-list")).toBeVisible();
    await expect.element(screen.getByText("Acme Core")).toBeVisible();
    await expect.element(screen.getByText("Platform Ops")).toBeVisible();
    await expect
      .element(screen.getByTestId(`notification-team-sound-select-${teamAId}`))
      .toHaveTextContent("Chime (Default)");
    await expect
      .element(screen.getByTestId(`notification-team-sound-select-${teamBId}`))
      .toHaveTextContent("Pulse");

    await screen.getByTestId(`notification-team-sound-preview-${teamBId}`).click();
    expect(mockState.previewSound).toHaveBeenCalledWith("pulse");

    // Multi-team rows expose a reset button for customized teams and delete the override key.
    await screen.getByLabelText("Reset Platform Ops notification sound to default").click();
    await expect
      .element(screen.getByTestId(`notification-team-sound-select-${teamBId}`))
      .toHaveTextContent("Chime (Default)");
    expect(Object.hasOwn(getClientSettings().teamNotificationSounds, teamBId)).toBe(false);
  });

  it("renders TeamNotificationSoundRow for Settings -> Teams with preview and persistence", async () => {
    using _env = setup();
    await using screen = await render(
      <TeamNotificationSoundRow team={{ id: teamAId, name: "Acme Core" }} />,
    );

    const trigger = screen.getByTestId(`team-settings-sound-select-${teamAId}`);
    await expect.element(trigger).toHaveTextContent("Chime (Default)");

    await screen.getByTestId(`team-settings-sound-preview-${teamAId}`).click();
    expect(mockState.previewSound).toHaveBeenCalledWith("chime");

    await trigger.click();
    await screen.getByTestId("team-settings-sound-option-bell").click();
    await expect.element(trigger).toHaveTextContent("Bell");
    expect(getClientSettings().teamNotificationSounds[teamAId]).toBe("bell");
  });

  it("reports a toast error when persisting a team notification sound change fails", async () => {
    using _env = setup({
      setClientSettingsError: new Error("Disk full"),
    });
    await using screen = await render(
      <TeamNotificationSoundRow team={{ id: teamAId, name: "Acme Core" }} />,
    );

    await screen.getByTestId(`team-settings-sound-select-${teamAId}`).click();
    await screen.getByTestId("team-settings-sound-option-marimba").click();

    await vi.waitFor(() => {
      expect(mockState.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Setting not saved",
          description: "Disk full",
        }),
      );
    });
    expect(getClientSettings().teamNotificationSounds[teamAId]).toBeUndefined();
  });
});
