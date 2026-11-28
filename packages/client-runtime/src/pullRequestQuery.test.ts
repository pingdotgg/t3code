import { describe, expect, it } from "vite-plus/test";
import {
  applyPullRequestFilterChange,
  parsePullRequestQuery,
  pullRequestMenuFilters,
} from "./pullRequestQuery.ts";

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
    expect(parsePullRequestQuery("-draft:true").filters).toEqual({ draft: "hide" });
  });

  it("leaves an unknown value and a stray colon as text, and reads an unknown key as a label", () => {
    const parsed = parsePullRequestQuery("milestone:v2 draft:maybe status: parser");
    expect(parsed.filters).toEqual({ labels: [["milestone:v2"]] });
    expect(parsed.text).toBe("draft:maybe status: parser");
    expect(parsePullRequestQuery("review:constructor checks:__proto__ Status:toString")).toEqual({
      text: "review:constructor checks:__proto__ Status:toString",
      filters: {},
    });
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

  // regression: #30131 a query pasted from github.com lists nothing
  it("ignores GitHub's own search qualifiers instead of reading them as labels", () => {
    expect(
      parsePullRequestQuery(
        "is:pr state:open archived:false repo:org/repo org:org user:alice sort:updated-desc -repo:org/fork -state:closed fix",
      ),
    ).toEqual({ text: "fix", filters: {} });
    expect(parsePullRequestQuery("type:pr is:open bug")).toEqual(
      parsePullRequestQuery("is:pr is:open bug"),
    );
    expect(parsePullRequestQuery("TYPE:PR bug")).toEqual({ text: "bug", filters: {} });
    expect(parsePullRequestQuery("type:bug -type:pr label:type:pr").filters).toEqual({
      labels: [["type:bug"], ["type:pr"]],
      excludedLabels: ["type:pr"],
    });
  });

  it("sets no author when the query names more than one", () => {
    expect(parsePullRequestQuery("author:alice author:bob").filters).toEqual({});
    expect(parsePullRequestQuery("author:me author:@me").filters).toEqual({ author: "me" });
  });

  it("cuts a typed query back to what the contract carries", () => {
    const many = Array.from({ length: 14 }, (_, index) => `l${index}`).join(",");
    const long = "x".repeat(240);
    const parsed = parsePullRequestQuery(
      `label:${many} label:${long} author:${long} ${"fix ".repeat(80)}`,
    );
    expect(parsed.filters.labels?.[0]).toHaveLength(10);
    expect(parsed.filters.labels?.[1]).toEqual(["x".repeat(200)]);
    expect(parsed.filters.author).toBe("x".repeat(200));
    expect(parsed.text).toBe("fix ".repeat(50).trim());

    const prefix = "x".repeat(199);
    const split = `${prefix}😀`;
    expect(parsePullRequestQuery(split).text).toBe(prefix);
    expect(parsePullRequestQuery(`${"x".repeat(198)}😀x`).text).toBe(`${"x".repeat(198)}😀`);
    expect(parsePullRequestQuery(`label:${split} -label:${split} author:${split}`).filters).toEqual(
      {
        labels: [[prefix]],
        excludedLabels: [prefix],
        author: prefix,
      },
    );
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
    expect(parsePullRequestQuery("security:cve:critical,area:web,low").filters.labels).toEqual([
      ["security:cve:critical", "area:web", "security:low"],
    ]);
    expect(parsePullRequestQuery("size:,area:web").filters.labels).toEqual([["area:web"]]);
  });

  // regression: #19934 negated key:value qualifiers become namespaced label exclusions
  it("excludes one the same way", () => {
    expect(parsePullRequestQuery("-size:XXL").filters.excludedLabels).toEqual(["size:XXL"]);
    expect(parsePullRequestQuery("-security:cve:critical").filters.excludedLabels).toEqual([
      "security:cve:critical",
    ]);
    expect(parsePullRequestQuery("-size:,area:web").filters.excludedLabels).toEqual(["area:web"]);
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

describe("changing a menu filter after typing its qualifier", () => {
  it("replaces or clears a typed draft qualifier and keeps the rest of the query", () => {
    expect(
      applyPullRequestFilterChange('draft:false fix label:"needs design"', {}, { draft: "only" }),
    ).toEqual({ query: 'fix label:"needs design"', filters: { draft: "only" } });
    expect(
      applyPullRequestFilterChange('draft:true "draft:false" fix', { draft: "only" }, {}),
    ).toEqual({
      query: '"draft:false" fix',
      filters: {},
    });
  });

  it("keeps the typed query and the stored menu draft when another filter changes", () => {
    expect(
      applyPullRequestFilterChange(
        "draft:false fix",
        { draft: "only" },
        { draft: "hide", checks: "passing" },
      ),
    ).toEqual({ query: "draft:false fix", filters: { draft: "only", checks: "passing" } });
  });

  it("replaces or clears a typed checks or status qualifier", () => {
    expect(applyPullRequestFilterChange("checks:passing fix", {}, { checks: "failing" })).toEqual({
      query: "fix",
      filters: { checks: "failing" },
    });
    expect(
      applyPullRequestFilterChange(
        'status:success "checks:passing" fix',
        { checks: "failing" },
        {},
      ),
    ).toEqual({ query: '"checks:passing" fix', filters: {} });
  });

  it("replaces a typed review qualifier and leaves the other typed qualifiers alone", () => {
    expect(
      applyPullRequestFilterChange(
        "review:approved checks:failing draft:true fix",
        {},
        { review: "none", checks: "failing", draft: "only" },
      ),
    ).toEqual({ query: "checks:failing draft:true fix", filters: { review: "none" } });
  });

  it("keeps text the tokenizer skips, like an unclosed quote, when it strips a qualifier", () => {
    expect(
      applyPullRequestFilterChange('checks:passing "size:XL', {}, { checks: "failing" }).query,
    ).toBe('"size:XL');
    expect(
      applyPullRequestFilterChange("fix  review:approved   wip", {}, { review: "none" }).query,
    ).toBe("fix  wip");
  });

  it("shows typed qualifiers in place of the stored menu values", () => {
    expect(
      pullRequestMenuFilters(
        parsePullRequestQuery("status:success review:none label:bug fix").filters,
        { checks: "failing", draft: "hide", labels: [["wip"]] },
      ),
    ).toEqual({ checks: "passing", review: "none", draft: "hide", labels: [["wip"]] });
  });
});
