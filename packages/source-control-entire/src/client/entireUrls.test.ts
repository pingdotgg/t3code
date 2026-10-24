import { assert, describe, it } from "@effect/vitest";

import * as EntireUrls from "./entireUrls.ts";

describe("entireUrls", () => {
  it.each([
    ["entire://aws-us-east-2.entire.io/gh/Acme/Web.git", "gh", "gh/Acme/Web"],
    ["entire://localhost:8443/et/acme/web/", "et", "et/acme/web"],
  ] as const)("reads the cluster and repository of %s", (url, forge, repository) => {
    const remote = EntireUrls.parseEntireRemote(url);
    assert.strictEqual(remote?.forge, forge);
    assert.strictEqual(remote?.repository, repository);
    assert.strictEqual(remote?.remoteUrl, url);
  });

  it.each([
    "entire://cluster.entire.io@evil.example/gh/acme/web",
    "entire:///gh/acme/web",
    "entire://cluster.entire.io/gl/acme/web",
    "entire://cluster.entire.io/gh/acme",
    "entire://cluster.entire.io/gh/acme/web/extra",
    "entire://cluster.entire.io/gh/../web",
    "https://entire.io/gh/acme/web",
  ])("is not an Entire clone URL: %s", (url) => {
    assert.isNull(EntireUrls.parseEntireRemote(url));
  });

  it.each([
    ["https://entire.com/gh/acme/web/trails/12", "gh/acme/web", 12],
    ["https://entire.com/et/acme/web/trails/7/fix-the-thing", "et/acme/web", 7],
    ["https://entire.io/gh/acme/web/trails/12", "gh/acme/web", 12],
    ["https://entire.com/et/acme/-/trails/1070/changes/web/124", "et/acme/web", 124],
    ["https://entire.com/et/acme/web/-/trails/1070/changes/124", "et/acme/web", 124],
  ] as const)("reads the change in %s", (url, repository, number) => {
    const trail = EntireUrls.parseEntireTrailUrl(url);
    assert.strictEqual(trail?.repository, repository);
    assert.strictEqual(trail?.number, number);
  });

  it.each([
    "http://entire.io/gh/acme/web/trails/12",
    "https://evil.example/gh/acme/web/trails/12",
    "https://entire.io/gh/acme/web/pulls/12",
    "https://entire.io/gh/acme/web/trails/0",
    "https://entire.io/gh/acme/web/trails/12/slug/more",
    // A project trail spans repositories; only its changes are one repository's work.
    "https://entire.com/et/acme/-/trails/1070",
    "https://entire.com/et/acme/-/trails/1070/changes/../124",
  ])("is not a change URL: %s", (url) => {
    assert.isNull(EntireUrls.parseEntireTrailUrl(url));
  });

  it.each([
    ["https://entire.com/et/entirehq/agent-insights", "et/entirehq/agent-insights"],
    ["https://entire.io/gh/Acme/Web.git", "gh/Acme/Web"],
    ["https://entire.com/et/acme/web/trails/7", "et/acme/web"],
  ] as const)("reads the repository a page of %s is in", (url, repository) => {
    assert.strictEqual(EntireUrls.parseEntireRepositoryUrl(url)?.repository, repository);
  });

  it.each([
    "https://entire.com/et/acme/-/trails/1070",
    "https://entire.com/et/acme",
    "https://github.com/acme/web",
    "http://entire.com/et/acme/web",
  ])("is not a repository page: %s", (url) => {
    assert.isNull(EntireUrls.parseEntireRepositoryUrl(url));
  });
});
