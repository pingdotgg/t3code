import { describe, expect, it } from "vite-plus/test";

import { filterSettingsSections } from "./settings-search";

const SECTIONS = [
  { rows: [{ id: "usage", label: "Usage" }] },
  {
    title: "Connections",
    rows: [
      { id: "account", label: "T3 Account" },
      { id: "SettingsEnvironments", label: "Environments" },
    ],
  },
  {
    title: "Interface",
    rows: [
      { id: "SettingsAppearance", label: "Appearance" },
      { id: "SettingsKeyboard", label: "Keyboard" },
      { id: "SettingsVoice", label: "Voice" },
    ],
  },
  { title: "Code", rows: [{ id: "SettingsProjectOverview", label: "Projects" }] },
  {
    title: "Server settings",
    rows: [
      { id: "SettingsProviderAccounts", label: "Provider accounts" },
      { id: "SettingsEnvironmentSourceControl", label: "Source control & issues" },
    ],
  },
  { title: "Advanced", rows: [{ id: "SettingsLabs", label: "Labs" }] },
];

function visible(query: string, platform = "ios") {
  return filterSettingsSections(SECTIONS, query, platform).map((section) => [
    section.title ?? null,
    section.rows.map((row) => row.label),
  ]);
}

describe("filterSettingsSections", () => {
  it.each([
    {
      query: "",
      expected: SECTIONS.map((section) => [
        section.title ?? null,
        section.rows.map((row) => row.label),
      ]),
    },
    { query: "   ", expected: visible("") },
    { query: "appear", expected: [["Interface", ["Appearance"]]] },
    { query: "KEYBOARD", expected: [["Interface", ["Keyboard"]]] },
    { query: "dark mode", expected: [["Interface", ["Appearance"]]] },
    { query: "microphone", expected: [["Interface", ["Voice"]]] },
    { query: "agent credits", expected: [["Server settings", ["Source control & issues"]]] },
    {
      query: "server settings",
      expected: [["Server settings", ["Provider accounts", "Source control & issues"]]],
    },
    {
      query: "accounts",
      expected: [["Server settings", ["Provider accounts"]]],
    },
    { query: "usage", expected: [[null, ["Usage"]]] },
    { query: "pin", expected: [["Code", ["Projects"]]] },
    { query: "pin project", expected: [["Code", ["Projects"]]] },
    { query: "pinned projects", expected: [["Code", ["Projects"]]] },
    { query: "zzzz", expected: [] },
  ])("$query", ({ query, expected }) => {
    expect(visible(query)).toEqual(expected);
  });

  it.each([
    { platform: "android", expected: [["Advanced", ["Labs"]]] },
    // Labs renders the battery saver setting only on Android.
    { platform: "ios", expected: [] },
  ])("finds battery saver on $platform", ({ platform, expected }) => {
    expect(visible("battery saver", platform)).toEqual(expected);
  });

  it("drops sections that start empty", () => {
    expect(filterSettingsSections([{ rows: [] }, ...SECTIONS], "", "ios").length).toBe(
      SECTIONS.length,
    );
  });
});
