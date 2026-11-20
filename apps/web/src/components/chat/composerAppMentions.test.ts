import type { EnvironmentId, LocalApp } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerAppItems } from "./composerAppMentions";

const apps: LocalApp[] = [
  { name: "카카오톡", path: "/Applications/KakaoTalk.app", running: true },
  {
    name: "Slack",
    path: "/Applications/Slack.app",
    bundleId: "com.tinyspeck.slackmacgap",
    running: true,
  },
  { name: "Calendar", path: "/System/Applications/Calendar.app", running: false },
  { name: "Notes", path: "/System/Applications/Notes.app", running: false },
];

function match(query: string) {
  return matchComposerAppItems({ apps, environmentId: "env" as EnvironmentId, query }).map(
    (item) => item.label,
  );
}

describe("matchComposerAppItems", () => {
  it("offers nothing for a bare @, so it stays a file picker", () => {
    expect(match("  ")).toEqual([]);
  });

  it("ranks name prefixes ahead of substrings and matches a localized app by its bundle name", () => {
    expect(match("c")).toEqual(["Calendar", "Slack"]);
    expect(match("kakao")).toEqual(["카카오톡"]);
  });
});
