import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Entire change request URLs", () => {
  it("reads a change however Entire links it, on entire.com or entire.io", () => {
    for (const url of [
      "https://entire.com/gh/Acme/Web/trails/12",
      "https://entire.com/gh/acme/web/trails/12/fix-the-thing",
      "https://entire.io/gh/acme/web/trails/12",
      "https://entire.com/gh/acme/-/trails/1070/changes/web/12",
      "https://entire.com/gh/acme/web/-/trails/1070/changes/12",
    ]) {
      expect(parse(url), url).toEqual({
        host: "entire.com",
        repository: "gh/acme/web",
        number: 12,
        repositoryUrl: "https://entire.com/gh/acme/web",
      });
    }
    expect(parse("https://entire.com/et/project/-/trails/9/changes/repo/3")?.repositoryUrl).toBe(
      "https://entire.com/et/project/repo",
    );
  });

  it("does not read a project trail as one repository's change", () => {
    expect(parse("https://entire.com/gh/acme/-/trails/1070")).toBeNull();
  });

  it("rejects other forges, routes, numbers and hosts", () => {
    for (const url of [
      "https://entire.com/gl/acme/web/trails/12",
      "https://entire.com/gh/acme/web/trails/12/files/x",
      "https://entire.com/gh/acme/web/trails/0",
      "https://entire.com/gh/acme/-/trails/1070/changes/../12",
      "https://scm.example/gh/acme/web/trails/12",
      "https://scm.example/tfs/trails/123/_git/repo/pullrequest/42",
    ]) {
      expect(parse(url), url).toBeNull();
    }
  });

  it("builds trail URLs on entire.com", () => {
    expect(
      definition.changeRequestUrl({ host: "entire.com", repository: "et/project/repo", number: 3 }),
    ).toBe("https://entire.com/et/project/repo/trails/3");
  });

  it("calls its change requests trails", () => {
    expect(definition.changeRequest).toEqual({
      shortLabel: "trail",
      shortLabelWithArticle: "a trail",
      singular: "trail",
      plural: "trails",
    });
  });
});

describe("Entire remotes", () => {
  it("recognises Entire by its clone scheme alone, and never by an https host", () => {
    for (const remote of [
      "entire://aws-us-east-2.entire.io/gh/acme/web.git",
      "entire://localhost:8443/et/project/repo",
    ]) {
      expect(recognizeRemoteWith(definition, remote), remote).toEqual({
        kind: "entire",
        name: "Entire",
        baseUrl: "https://entire.com",
      });
    }
    expect(recognizeRemoteWith(definition, "https://github.entire.io/a/b.git")).toBeNull();
    expect(recognizeRemoteWith(definition, "https://entire.com/gh/acme/web")).toBeNull();
  });
});
