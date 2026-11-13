import { expect, it } from "@effect/vitest";

import {
  BUILT_IN_SOURCE_CONTROL_DRIVER_LIST,
  changeRequestsClosedBy,
  sourceControlDefinitions,
} from "./sourceControlDefinitions.ts";

it("runs a driver for every host the server and clients read, in their order", () => {
  expect(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST.map((driver) => driver.definition)).toEqual(
    sourceControlDefinitions.definitions,
  );
});

it.each([
  "C:/repos/project",
  "C:\\repos\\project",
  "/srv/git/repo.git",
  "./team:group/repo",
  "file:///srv/git/repo.git",
  "hg::team/repo",
  "codecommit::us-east-1://repo",
])("finds no host in %s, which git does not read as SSH", (remoteUrl) => {
  expect(sourceControlDefinitions.recognizeRemote(remoteUrl)).toBeNull();
});

it.each([
  ["gh pr merge 19 --squash", [19]],
  ['gh pr merge "19" --squash', [19]],
  ['/bin/zsh -lc "gh pr merge 19"', [19]],
  ['gh pr merge 19 --squash --subject "Release 20"', [19]],
  [`/bin/zsh -lc "gh pr merge 19 --subject 'Release 20'"`, [19]],
  ["gh pr merge 19 --body 'see https://github.com/o/r/pull/20'", [19]],
  ["gh pr merge 19 # then 20", [19]],
  ["gh pr merge --squash --match-head-commit 3b2f958 #19", [19]],
  ["gh pr close https://github.com/o/r/pull/19 && gh pr merge 20", [19, 20]],
  ["glab mr merge https://gitlab.com/o/r/-/merge_requests/7", [7]],
  ["sleep 30; cafe pr merge 26271", [26271]],
  ["az repos pr update --id 19 --status completed", [19]],
  ["az repos pr update --id=19 --status=abandoned", [19]],
  ["gh pr merge --squash", "any"],
  ["gh stack merge", "any"],
  ["gh pr merge 19 && gh pr merge --auto", "any"],
] as const)("%s closes %j", (command, expected) => {
  const closed = changeRequestsClosedBy(command);
  expect(closed === "any" ? closed : [...closed]).toEqual(expected);
});
