import { describe, expect, it } from "vite-plus/test";

import { mergeLocalApps, parseLsappinfoList } from "./LocalApps.ts";

const LSAPPINFO_OUTPUT = `
 1) "loginwindow" ASN:0x0-0x2002:
    bundleID="com.apple.loginwindow"
    bundle path="/System/Library/CoreServices/loginwindow.app"
    pid = 400 type="UIElement" flavor=3 Version="2.0"
 9) "Discord" ASN:0x0-0x12012:
    bundleID="com.hnc.Discord"
    bundle path="/Applications/Discord.app"
    executable path="/Applications/Discord.app/Contents/MacOS/Discord"
    pid = 514 type="Foreground" flavor=3 Version="0.0.423" fileType="APPL"
    parentASN="loginwindow" ASN:0x0-0x2002:
11) "Safari" ASN:0x0-0x14014:
    bundleID="com.apple.Safari"
    bundle path="/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app"
    pid = 517 type="Foreground" flavor=3 Version="21624.5.1.11.3" sandboxed
12) "카카오톡" ASN:0x0-0x15015:
    bundleID=[ NULL ]
    bundle path="/Applications/KakaoTalk.app"
    pid = 530 type="Foreground" flavor=3 Version="2010"
13) "helper" ASN:0x0-0x16016:
    bundleID="com.example.helper"
    pid = 531 type="Foreground" flavor=3
`;

describe("parseLsappinfoList", () => {
  it("keeps foreground app bundles with their ids, dropping agents and bundle-less processes", () => {
    expect(parseLsappinfoList(LSAPPINFO_OUTPUT)).toEqual([
      { name: "Discord", path: "/Applications/Discord.app", bundleId: "com.hnc.Discord" },
      {
        name: "Safari",
        path: "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app",
        bundleId: "com.apple.Safari",
      },
      { name: "카카오톡", path: "/Applications/KakaoTalk.app", bundleId: undefined },
    ]);
  });
});

describe("mergeLocalApps", () => {
  it("lists running apps first and an installed app that is running only once", () => {
    const apps = mergeLocalApps({
      running: parseLsappinfoList(LSAPPINFO_OUTPUT),
      installedPaths: [
        "/Applications/Zed.app",
        "/Applications/Safari.app",
        "/Applications/KakaoTalk.app",
        "/System/Applications/Calendar.app",
      ],
    });
    expect(apps.map((app) => [app.name, app.running])).toEqual([
      ["Discord", true],
      ["Safari", true],
      ["카카오톡", true],
      ["Calendar", false],
      ["Zed", false],
    ]);
    expect(apps.find((app) => app.name === "카카오톡")).not.toHaveProperty("bundleId");
  });
});
