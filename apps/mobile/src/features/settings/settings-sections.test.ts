import { describe, expect, it } from "vite-plus/test";

import {
  buildSettingsNavigationGroups,
  resolveSettingsLocation,
  settingsSectionState,
  settingsSheetStateFor,
} from "./settings-sections";

const sheet = (
  state?: Parameters<typeof resolveSettingsLocation>[0]["state"],
  params?: object,
) => ({
  name: "SettingsSheet",
  ...(params ? { params } : {}),
  ...(state ? { state } : {}),
});

/** A sheet opened with `navigate`, before its nested stacks mount. */
const navigatedTo = (page: string) =>
  sheet(
    undefined,
    page === "SettingsAuth"
      ? { screen: page }
      : { screen: "SettingsContent", params: { screen: page } },
  );

describe("resolveSettingsLocation", () => {
  it("shows the index as Environments", () => {
    expect(resolveSettingsLocation(sheet())).toEqual({
      section: "SettingsEnvironments",
      atSectionRoot: true,
    });
  });

  it("reads a section from params before the nested stacks mount", () => {
    expect(resolveSettingsLocation(navigatedTo("SettingsAppearance"))).toEqual({
      section: "SettingsAppearance",
      atSectionRoot: true,
    });
    expect(resolveSettingsLocation(navigatedTo("SettingsAuth"))).toEqual({
      section: "SettingsAuth",
      atSectionRoot: true,
    });
  });

  it("highlights the parent section of a pushed page", () => {
    const location = resolveSettingsLocation(
      sheet({
        index: 0,
        routes: [
          {
            name: "SettingsContent",
            state: {
              index: 1,
              routes: [{ name: "SettingsAbout" }, { name: "SettingsClientStorage" }],
            },
          },
        ],
      }),
    );
    expect(location).toEqual({ section: "SettingsAbout", atSectionRoot: false });
  });

  it("follows a section opened on top of another one", () => {
    const location = resolveSettingsLocation(
      sheet({
        routes: [
          {
            name: "SettingsContent",
            state: { routes: [{ name: "SettingsEnvironments" }, { name: "SettingsAppearance" }] },
          },
        ],
      }),
    );
    expect(location).toEqual({ section: "SettingsAppearance", atSectionRoot: false });
  });

  it("treats a sub-page opened directly as part of its section, not its root", () => {
    const location = resolveSettingsLocation(navigatedTo("SettingsDiagnostics"));
    expect(location).toEqual({ section: "SettingsAbout", atSectionRoot: false });
  });

  it("maps the waitlist to the account it was opened from", () => {
    const location = resolveSettingsLocation(
      sheet({ index: 1, routes: [{ name: "SettingsContent" }, { name: "SettingsWaitlist" }] }),
    );
    expect(location).toEqual({ section: "SettingsAuth", atSectionRoot: false });
  });
});

describe("settingsSheetStateFor", () => {
  const content = (...routes: Array<{ name: string; params?: object }>) => ({
    name: "SettingsContent",
    state: { routes },
  });
  const detail = { name: "SettingsEnvironmentDetail", params: { environmentId: "env-1" } };

  it("pushes a sidebar section and its pages above the index in a sheet", () => {
    expect(
      settingsSheetStateFor(
        sheet({ routes: [content({ name: "SettingsEnvironments" }, detail)] }),
        false,
      ),
    ).toEqual({
      routes: [content({ name: "Settings" }, { name: "SettingsEnvironments" }, detail)],
    });
  });

  it("keeps the Environments page the sidebar showed for its index", () => {
    expect(settingsSheetStateFor(sheet(), false)).toEqual({
      routes: [content({ name: "Settings" }, { name: "SettingsEnvironments" })],
    });
    expect(
      settingsSheetStateFor(sheet({ routes: [content({ name: "Settings" }, detail)] }), false),
    ).toEqual({
      routes: [content({ name: "Settings" }, { name: "SettingsEnvironments" }, detail)],
    });
  });

  it("opens the account above the index in a sheet", () => {
    expect(settingsSheetStateFor(navigatedTo("SettingsAuth"), false)).toEqual({
      routes: [{ name: "SettingsContent" }, { name: "SettingsAuth" }],
    });
  });

  it("makes the sheet's section a root page in the sidebar", () => {
    expect(
      settingsSheetStateFor(
        sheet({
          routes: [
            content(
              { name: "Settings" },
              { name: "SettingsAbout" },
              { name: "SettingsClientStorage" },
            ),
          ],
        }),
        true,
      ),
    ).toEqual({
      routes: [content({ name: "SettingsAbout" }, { name: "SettingsClientStorage" })],
    });
    expect(settingsSheetStateFor(navigatedTo("SettingsMicrophone"), true)).toEqual({
      routes: [content({ name: "SettingsMicrophone" })],
    });
  });

  it("drops the sheet's index from the sidebar unless it is the page showing", () => {
    expect(settingsSheetStateFor(sheet({ routes: [content({ name: "Settings" })] }), true)).toEqual(
      { routes: [content({ name: "Settings" })] },
    );
    expect(
      settingsSheetStateFor(
        sheet({ routes: [content({ name: "Settings" }), { name: "SettingsWaitlist" }] }),
        true,
      ),
    ).toEqual({ routes: [{ name: "SettingsWaitlist" }] });
  });

  it("returns to the same sidebar section after a round trip through a sheet", () => {
    const opened = [
      navigatedTo("SettingsAppearance"),
      navigatedTo("SettingsAuth"),
      sheet({ routes: [content({ name: "SettingsAbout" }, { name: "SettingsDiagnostics" })] }),
      sheet(),
    ];
    for (const route of opened) {
      const folded = sheet(settingsSheetStateFor(route, false));
      const unfolded = sheet(settingsSheetStateFor(folded, true));
      expect(resolveSettingsLocation(unfolded)).toEqual(resolveSettingsLocation(route));
    }
  });
});

describe("settingsSectionState", () => {
  it("opens a sidebar section as the root page of the sheet", () => {
    for (const section of ["SettingsAppearance", "SettingsAuth", "SettingsEnvironments"]) {
      expect(resolveSettingsLocation(sheet(settingsSectionState(section)))).toEqual({
        section,
        atSectionRoot: true,
      });
    }
  });
});

describe("buildSettingsNavigationGroups", () => {
  const sections = (groups: ReturnType<typeof buildSettingsNavigationGroups>) =>
    groups.flatMap((group) => group.items.map((item) => item.section));

  it("only offers account, notifications, and the project overview when they apply", () => {
    const local = buildSettingsNavigationGroups({
      account: null,
      environmentCount: 2,
      deviceInputSettings: false,
      projectLabel: null,
      serverSettingsAvailable: true,
    });
    expect(sections(local)).not.toContain("SettingsAuth");
    expect(sections(local)).not.toContain("SettingsNotifications");
    expect(sections(local)).not.toContain("SettingsProjectOverview");
    expect(sections(local)).not.toContain("SettingsKeyboard");

    const cloud = buildSettingsNavigationGroups({
      account: { label: "me@example.com", loading: false },
      environmentCount: 2,
      deviceInputSettings: true,
      projectLabel: "t3code",
      serverSettingsAvailable: false,
    });
    expect(sections(cloud)).toEqual(
      expect.arrayContaining([
        "SettingsAuth",
        "SettingsNotifications",
        "SettingsProjectOverview",
        "SettingsKeyboard",
        "SettingsMicrophone",
      ]),
    );
    const server = cloud.find((group) => group.title === "Server settings")!;
    expect(server.items.every((item) => item.disabled)).toBe(true);
  });
});
