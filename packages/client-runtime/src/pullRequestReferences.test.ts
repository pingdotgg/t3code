import { describe, expect, it } from "vite-plus/test";

import { changeRequestReferenceAutolinker } from "./pullRequestReferences.ts";

describe("changeRequestReferenceAutolinker", () => {
  it("resolves GitHub issue URLs including custom enterprise hosts", () => {
    const github = changeRequestReferenceAutolinker({
      provider: "github",
      url: "https://github.com/Acme/Web/issues/42",
    });
    expect(github?.("Fix opened in #38661 and other/repo#9.")).toEqual([
      {
        index: 14,
        text: "#38661",
        label: "#38661",
        url: "https://github.com/Acme/Web/issues/38661",
        kind: "reference",
      },
      {
        index: 25,
        text: "other/repo#9",
        label: "other/repo#9",
        url: "https://github.com/other/repo/issues/9",
        kind: "reference",
      },
    ]);

    const ghes = changeRequestReferenceAutolinker({
      provider: "github",
      url: "https://git.corp.example/Acme/Web/issues/42",
    });
    expect(ghes?.("See #7")).toEqual([
      {
        index: 4,
        text: "#7",
        label: "#7",
        url: "https://git.corp.example/Acme/Web/issues/7",
        kind: "reference",
      },
    ]);
  });

  it("resolves GitLab issue URLs including nested groups and merge request references", () => {
    const gitlab = changeRequestReferenceAutolinker({
      provider: "gitlab",
      url: "https://gitlab.example/group/sub/Web/-/issues/7",
    });
    expect(gitlab?.("Fix in !15 for #12")).toEqual([
      {
        index: 7,
        text: "!15",
        label: "!15",
        url: "https://gitlab.example/group/sub/Web/-/merge_requests/15",
        kind: "reference",
      },
      {
        index: 15,
        text: "#12",
        label: "#12",
        url: "https://gitlab.example/group/sub/Web/-/issues/12",
        kind: "reference",
      },
    ]);
  });

  it("returns null for standalone issue trackers such as Linear", () => {
    expect(
      changeRequestReferenceAutolinker({
        provider: "linear",
        url: "https://linear.app/acme/issue/ENG-1",
      }),
    ).toBeNull();
  });
});
