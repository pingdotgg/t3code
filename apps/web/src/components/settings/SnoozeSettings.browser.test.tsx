import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SNOOZE_PRESETS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import {
  readBrowserClientSettings,
  writeBrowserClientSettings,
} from "../../clientPersistenceStorage";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
  persistClientSettingsPatch,
  useMergedSettings,
} from "../../hooks/useSettings";
import { SnoozeSettings } from "./SnoozeSettings";

import "../../index.css";

vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => useMergedSettings(DEFAULT_SERVER_SETTINGS),
  useUpdateScopedSettings: () => persistClientSettingsPatch,
  useClearScopedSettings: () => () => {},
  useClearProjectOverrides: () => () => {},
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => readBrowserClientSettings(),
      setClientSettings: async (settings: Parameters<typeof writeBrowserClientSettings>[0]) =>
        writeBrowserClientSettings(settings),
    },
  }),
}));

function setup() {
  const key = "t3code:client-settings:v1";
  const previous = localStorage.getItem(key);
  __resetClientSettingsPersistenceForTests();
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    snoozePreferences: [
      { mode: "relative" as const, hours: 8 },
      ...DEFAULT_SNOOZE_PRESETS.slice(1),
    ],
  };
  __setClientSettingsForTests(settings);
  writeBrowserClientSettings(settings);
  return {
    [Symbol.dispose]() {
      __resetClientSettingsPersistenceForTests();
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    },
  };
}

it("ignores fractional hours without blocking later client-setting persistence", async () => {
  using _settings = setup();
  await using screen = await render(<SnoozeSettings />);
  await userEvent.click(screen.getByRole("button", { name: "Snooze", exact: true }));
  const hours = screen.container.querySelector<HTMLInputElement>(
    'input[aria-label="Snooze slot 1 hours"]',
  )!;

  await userEvent.fill(hours, "1.5");
  await act(() => persistClientSettingsPatch({ timestampFormat: "24-hour" }));

  expect(readBrowserClientSettings()).toMatchObject({
    timestampFormat: "24-hour",
    snoozePreferences: [{ mode: "relative", hours: 8 }, ...DEFAULT_SNOOZE_PRESETS.slice(1)],
  });
  expect(getClientSettings().snoozePreferences?.[0]).toEqual({ mode: "relative", hours: 8 });

  await userEvent.fill(hours, "168");
  await act(() => persistClientSettingsPatch({ timestampFormat: "12-hour" }));
  expect(readBrowserClientSettings()).toMatchObject({
    timestampFormat: "12-hour",
    snoozePreferences: [{ mode: "relative", hours: 168 }, ...DEFAULT_SNOOZE_PRESETS.slice(1)],
  });
});

it("allows clearing and replacing a snooze time without persisting an empty value", async () => {
  using _settings = setup();
  await using screen = await render(<SnoozeSettings />);
  await userEvent.click(screen.getByRole("button", { name: "Snooze", exact: true }));
  const time = screen.container.querySelector<HTMLInputElement>(
    'input[aria-label="Snooze slot 3 time"]',
  )!;

  await userEvent.fill(time, "");
  await expect.element(time).toHaveValue("");
  await act(() => persistClientSettingsPatch({ timestampFormat: "24-hour" }));
  expect(readBrowserClientSettings()?.snoozePreferences?.[2]).toEqual({
    mode: "absolute",
    day: "today",
    time: "18:00",
  });
  await expect.element(time).toHaveValue("");

  await userEvent.fill(time, "06:30");
  await vi.waitFor(() => {
    expect(readBrowserClientSettings()?.snoozePreferences?.[2]).toEqual({
      mode: "absolute",
      day: "today",
      time: "06:30",
    });
  });
});

it("restores an empty time on blur and reflects changes to the saved time", async () => {
  using _settings = setup();
  await using screen = await render(<SnoozeSettings />);
  await userEvent.click(screen.getByRole("button", { name: "Snooze", exact: true }));
  const time = screen.container.querySelector<HTMLInputElement>(
    'input[aria-label="Snooze slot 3 time"]',
  )!;
  const hours = screen.container.querySelector<HTMLInputElement>(
    'input[aria-label="Snooze slot 1 hours"]',
  )!;

  await userEvent.fill(time, "");
  await expect.element(time).toHaveValue("");
  await userEvent.click(hours);
  await expect.element(time).toHaveValue("18:00");

  await userEvent.fill(time, "");
  const preferences = [...DEFAULT_SNOOZE_PRESETS];
  preferences[2] = { mode: "absolute", day: "today", time: "20:00" };
  await act(() => persistClientSettingsPatch({ snoozePreferences: preferences }));
  await expect.element(time).toHaveValue("20:00");
});
