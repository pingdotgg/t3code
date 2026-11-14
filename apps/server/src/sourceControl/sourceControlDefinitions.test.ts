import { expect, it } from "@effect/vitest";

import {
  BUILT_IN_SOURCE_CONTROL_DRIVER_LIST,
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
])("finds no host in %s, which git does not read as SSH", (remoteUrl) => {
  expect(sourceControlDefinitions.recognizeRemote(remoteUrl)).toBeNull();
});

it.each(["codecommit://self@Repo", "codecommit::us-east-1://self@Repo"])(
  "recognizes CodeCommit helper remote %s",
  (remoteUrl) => {
    expect(sourceControlDefinitions.recognizeRemote(remoteUrl)?.kind).toBe("aws-codecommit");
    expect(
      sourceControlDefinitions.canonicalRepositoryKey(
        "git-codecommit.us-east-1.amazonaws.com/123456789012/v1/repos/Repo",
      ),
    ).toBe("git-codecommit.us-east-1.amazonaws.com/123456789012/v1/repos/Repo");
  },
);
