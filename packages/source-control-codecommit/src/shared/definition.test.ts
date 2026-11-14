import { makeSourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";
import {
  codeCommitChangeRequestUrl,
  codeCommitCommitUrl,
  codeCommitRepositoryKey,
  codeCommitRepositoryUrl,
  definition,
  parseCodeCommitConsoleUrl,
  parseCodeCommitRemote,
  parseCodeCommitHelperRemote,
} from "./definition.ts";

const registry = makeSourceControlDefinitionRegistry([definition]);
const repo = { region: "us-east-1", partition: "aws" as const, repository: "MyRepo" };

describe("CodeCommit remotes", () => {
  it("preserves case and equates HTTPS and SSH clones", () => {
    for (const remote of [
      "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
      "https://git-codecommit-fips.us-east-1.amazonaws.com/v1/repos/MyRepo",
      "ssh://APKAEXAMPLE@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
      "APKAEXAMPLE@git-codecommit.us-east-1.amazonaws.com:v1/repos/MyRepo",
    ])
      expect(registry.repositoryKeyFromRemote(remote)).toBe(
        "git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
      );
    expect(
      registry.repositoryKeyFromRemote(
        "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/myrepo",
      ),
    ).not.toBe(codeCommitRepositoryKey(repo));
    expect(
      registry.canonicalRepositoryKey(
        codeCommitRepositoryKey({ ...repo, accountId: "123456789012" }),
      ),
    ).toBe("git-codecommit.us-east-1.amazonaws.com/123456789012/v1/repos/MyRepo");
    expect(
      registry.canonicalRepositoryKey("GIT-CODECOMMIT.US-EAST-1.AMAZONAWS.COM/v1/repos/MyRepo"),
    ).toBe("git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
  });
  it("parses helper URLs without inventing a region or normalizing repository case", () => {
    expect(parseCodeCommitHelperRemote("codecommit::us-east-1://dev+ops@MyRepo")).toEqual({
      profile: "dev+ops",
      region: "us-east-1",
      repository: "MyRepo",
    });
    expect(parseCodeCommitHelperRemote("codecommit://self@MyRepo")).toEqual({
      profile: "self",
      repository: "MyRepo",
    });
    expect(parseCodeCommitHelperRemote("codecommit::us-east-1://self@MyRepo")).toEqual({
      profile: "self",
      region: "us-east-1",
      repository: "MyRepo",
    });
    expect(registry.recognizeRemote("codecommit://self@MyRepo")?.kind).toBe("aws-codecommit");
    expect(registry.recognizeRemote("codecommit::us-east-1://self@MyRepo")?.kind).toBe(
      "aws-codecommit",
    );
    for (const remote of [
      "codecommit://self@Repo/extra",
      "codecommit://self@Repo?x=1",
      "codecommit::bad://Repo",
      "codecommit://self@..",
      "codecommit://self@Repo.git",
    ])
      expect(parseCodeCommitHelperRemote(remote)).toBeNull();
  });
  it("isolates partitions and regions", () => {
    for (const [remote, partition] of [
      ["https://git-codecommit.cn-north-1.amazonaws.com.cn/v1/repos/MyRepo", "aws-cn"],
      ["ssh://user@git-codecommit.us-gov-west-1.amazonaws.com/v1/repos/MyRepo", "aws-us-gov"],
      ["https://git-codecommit.us-west-2.amazonaws.com/v1/repos/MyRepo", "aws"],
    ] as const)
      expect(parseCodeCommitRemote(remote)?.partition).toBe(partition);
    expect(
      parseCodeCommitRemote("https://git-codecommit.cn-north-1.amazonaws.com/v1/repos/MyRepo"),
    ).toBeNull();
  });
  it("rejects nonstandard protocols, hosts and paths", () => {
    for (const remote of [
      "https://git-codecommit.us-east-1.amazonaws.com.evil.test/v1/repos/MyRepo",
      "https://s3.us-east-1.amazonaws.com/v1/repos/MyRepo",
      "codecommit://MyRepo",
      "codecommit::us-east-1://MyRepo",
      "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo/extra",
      "http://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
      "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/Repo.git",
      "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/Repo.GIT",
      "user@git-codecommit.us-east-1.amazonaws.com:v1/repos/.",
      "user@git-codecommit.us-east-1.amazonaws.com:v1/repos/..",
    ])
      expect(parseCodeCommitRemote(remote), remote).toBeNull();
  });
});

describe("CodeCommit console links", () => {
  it("round trips repository, commit and pull request links", () => {
    const sha = "a".repeat(40);
    const gov = { region: "us-gov-west-1", partition: "aws-us-gov" as const, repository: "MyRepo" };
    expect(codeCommitRepositoryUrl(gov)).toBe(
      "https://us-gov-west-1.console.amazonaws-us-gov.com/codesuite/codecommit/repositories/MyRepo/browse?region=us-gov-west-1",
    );
    expect(parseCodeCommitConsoleUrl(new URL(codeCommitChangeRequestUrl(gov, 23)))).toMatchObject({
      ...gov,
      number: 23,
    });
    expect(registry.repositoryUrlFromPage(codeCommitRepositoryUrl(repo))).toBe(
      "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo",
    );
    expect(parseCodeCommitConsoleUrl(new URL(codeCommitRepositoryUrl(repo)))).toMatchObject(repo);
    expect(definition.parseCommitUrl(new URL(codeCommitCommitUrl(repo, sha)))).toMatchObject({
      host: "git-codecommit.us-east-1.amazonaws.com",
      repository: "v1/repos/MyRepo",
      sha,
    });
    expect(
      definition.parseChangeRequestUrl(new URL(codeCommitChangeRequestUrl(repo, 23))),
    ).toMatchObject({ repository: "v1/repos/MyRepo", number: 23 });
    expect(
      parseCodeCommitConsoleUrl(
        new URL(
          "https://console.aws.amazon.com/codesuite/codecommit/repositories/MyRepo/browse?region=us-east-1",
        ),
      ),
    ).toMatchObject(repo);
  });
  it("rejects invalid or ambiguous links", () => {
    for (const value of [
      "https://us-gov-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/MyRepo/browse?region=us-gov-west-1",
      "https://console.aws.amazon.com.evil.test/codesuite/codecommit/repositories/MyRepo/browse?region=us-east-1",
      "https://console.aws.amazon.com/codesuite/codecommit/repositories/MyRepo/browse",
      "https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/MyRepo/browse?region=us-west-2",
      "https://console.aws.amazon.com/codesuite/codecommit/repositories/MyRepo/commit/bad?region=us-east-1",
      "https://console.aws.amazon.com/codesuite/codecommit/repositories/MyRepo/pull-requests/0/details?region=us-east-1",
    ])
      expect(parseCodeCommitConsoleUrl(new URL(value)), value).toBeNull();
  });
});
