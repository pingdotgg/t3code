import { expect, it } from "@effect/vitest";
import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";

import {
  BUILT_IN_SOURCE_CONTROL_DRIVER_LIST,
  sourceControlDefinitions,
  withSshHostAliases,
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

const sshConfig: Record<string, string> = {
  "gh-work": "github.com",
  "lab.work": "gitlab.com",
  "github.com": "ssh.github.com",
  "lan-box": "192.168.1.20",
};
const withSshConfig = withSshHostAliases(
  builtInSourceControlDefinitions,
  (host) => sshConfig[host] ?? host,
);

it.each([
  ["git@gh-work:Owner/Repo.git", "github", "github.com/owner/repo"],
  ["gh-work:owner/repo", "github", "github.com/owner/repo"],
  ["ssh://git@gh-work:22/owner/repo.git", "github", "github.com/owner/repo"],
  ["git@lab.work:group/repo.git", "gitlab", "gitlab.com/group/repo"],
  // A public forge host keeps its name, and an address or an HTTPS host is not an SSH alias.
  ["git@github.com:owner/repo.git", "github", "github.com/owner/repo"],
  ["git@lan-box:owner/repo.git", "unknown", "lan-box/owner/repo"],
  ["https://gh-work/owner/repo.git", "unknown", "gh-work/owner/repo"],
])("reads %s through its ssh config host", (remoteUrl, kind, key) => {
  expect(withSshConfig.recognizeRemote(remoteUrl)?.kind).toBe(kind);
  expect(withSshConfig.repositoryKeyFromRemote(remoteUrl)).toBe(key);
});
