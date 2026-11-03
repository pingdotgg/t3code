import { describe, expect, it } from "vite-plus/test";
import { applyPullRequestDraftFilterChange, parsePullRequestQuery } from "./pullRequestQuery.ts";

describe("reading qualifiers out of a typed query", () => {
  it("keeps quoted values whole and separates negation", () => {
    expect(parsePullRequestQuery('label:"needs design" -label:wip Fix the parser')).toEqual({
      text: "Fix the parser",
      filters: { labels: [["needs design"]], excludedLabels: ["wip"] },
    });
  });

  it("keeps the spaces in a quoted name of a list, and drops an empty part", () => {
    expect(parsePullRequestQuery('label:"needs design","wip"').filters.labels).toEqual([
      ["needs design", "wip"],
    ]);
    expect(parsePullRequestQuery("label:a,,b").filters.labels).toEqual([["a", "b"]]);
  });

  it("makes each label qualifier its own group, so the groups are an AND", () => {
    expect(parsePullRequestQuery("label:bug label:a,b").filters.labels).toEqual([
      ["bug"],
      ["a", "b"],
    ]);
  });

  it("reads the scalar qualifiers in GitHub's own spelling", () => {
    expect(
      parsePullRequestQuery("author:octocat DRAFT:false review:changes_requested status:failure")
        .filters,
    ).toEqual({
      author: "octocat",
      draft: "hide",
      review: "changes-requested",
      checks: "failing",
    });
  });

  it("leaves an unknown value and a stray colon as text, and reads an unknown key as a label", () => {
    const parsed = parsePullRequestQuery("milestone:v2 draft:maybe status: parser");
    expect(parsed.filters).toEqual({ labels: [["milestone:v2"]] });
    expect(parsed.text).toBe("draft:maybe status: parser");
  });

  it("reads a quoted name holding a comma as the one label it is", () => {
    expect(parsePullRequestQuery('label:"needs,triage"').filters.labels).toEqual([
      ["needs,triage"],
    ]);
    expect(parsePullRequestQuery('label:"needs,triage",wip').filters.labels).toEqual([
      ["needs,triage", "wip"],
    ]);
    expect(parsePullRequestQuery('-label:"needs,triage"').filters.excludedLabels).toEqual([
      "needs,triage",
    ]);
  });

  it("cuts a typed query back to what the contract carries", () => {
    const many = Array.from({ length: 14 }, (_, index) => `l${index}`).join(",");
    const long = "x".repeat(240);
    const parsed = parsePullRequestQuery(`label:${many} label:${long} author:${long}`);
    expect(parsed.filters.labels?.[0]).toHaveLength(10);
    expect(parsed.filters.labels?.[1]).toEqual(["x".repeat(200)]);
    expect(parsed.filters.author).toBe("x".repeat(200));
  });
});

describe("colon-namespaced labels typed as a search", () => {
  it("reads an unknown key as the label it almost always is", () => {
    expect(parsePullRequestQuery("size:XXL").filters.labels).toEqual([["size:XXL"]]);
    expect(parsePullRequestQuery("vouch:trusted").filters.labels).toEqual([["vouch:trusted"]]);
    expect(parsePullRequestQuery("size:XXL").text).toBe("");
  });

  it("reads the key as the namespace of every bare name in its list", () => {
    expect(parsePullRequestQuery("size:S,XS").filters.labels).toEqual([["size:S", "size:XS"]]);
  });

  it("leaves a name that already carries its own namespace alone", () => {
    expect(parsePullRequestQuery("size:S,size:XS").filters.labels).toEqual([["size:S", "size:XS"]]);
  });

  // regression: #19934 negated key:value qualifiers become namespaced label exclusions
  it("excludes one the same way", () => {
    expect(parsePullRequestQuery("-size:XXL").filters.excludedLabels).toEqual(["size:XXL"]);
    expect(parsePullRequestQuery("-size:S,XS").filters.excludedLabels).toEqual([
      "size:S",
      "size:XS",
    ]);
  });

  it("keeps a quoted token as text, which is the way back to a literal search", () => {
    const parsed = parsePullRequestQuery('"size:XXL"');
    expect(parsed.filters.labels).toBeUndefined();
    expect(parsed.text).toBe('"size:XXL"');
  });

  it("reads a hyphenated namespace as a label too", () => {
    expect(parsePullRequestQuery("priority-1:high").filters.labels).toEqual([["priority-1:high"]]);
    expect(parsePullRequestQuery("priority-1:high").text).toBe("");
  });

  it("leaves a pasted link alone rather than naming a label after its scheme", () => {
    const parsed = parsePullRequestQuery("https://github.com/pingdotgg/t3code/pull/1");
    expect(parsed.filters.labels).toBeUndefined();
    expect(parsed.text).toBe("https://github.com/pingdotgg/t3code/pull/1");
  });

  it("mixes with the keys it does know, and with plain words", () => {
    const parsed = parsePullRequestQuery("area:web draft:true wizard label:bug");
    expect(parsed.filters).toEqual({ labels: [["area:web"], ["bug"]], draft: "only" });
    expect(parsed.text).toBe("wizard");
  });
});

describe("changing the draft menu after typing a qualifier", () => {
  it("replaces or clears a typed draft qualifier and keeps the rest of the query", () => {
    expect(
      applyPullRequestDraftFilterChange(
        'draft:false fix label:"needs design"',
        {},
        { draft: "only" },
      ),
    ).toEqual({ query: 'fix label:"needs design"', filters: { draft: "only" } });
    expect(
      applyPullRequestDraftFilterChange('draft:true "draft:false" fix', { draft: "only" }, {}),
    ).toEqual({
      query: '"draft:false" fix',
      filters: {},
    });
  });

  it("keeps the typed query and the stored menu draft when another filter changes", () => {
    expect(
      applyPullRequestDraftFilterChange(
        "draft:false fix",
        { draft: "only" },
        { draft: "hide", checks: "passing" },
      ),
    ).toEqual({ query: "draft:false fix", filters: { draft: "only", checks: "passing" } });
  });
});
