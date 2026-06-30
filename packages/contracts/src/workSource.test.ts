import { assert, describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  GithubSelector,
  AsanaSelector,
  JiraSelector,
  WorkflowSourceConfig,
  SourceId,
  ImportableWorkItemView,
  ListImportableWorkItemsResult,
  ImportWorkItemsResult,
  ALWAYS_RULE,
  compileAutoPullRule,
  decodeAutoPullRule,
  effectiveAutoPullRule,
  type AutoPullCriteria,
} from "./workSource.ts";
import { WsWorkflowCreateWorkSourceConnectionRpc } from "./rpc.ts";

describe("workSource contracts", () => {
  it("defaults github selector state to 'all'", () => {
    const sel = Schema.decodeUnknownSync(GithubSelector)({ owner: "o", repo: "r" });
    expect(sel.state).toBe("all");
  });
  it("defaults asana includeCompleted to true", () => {
    const sel = Schema.decodeUnknownSync(AsanaSelector)({ projectGid: "123" });
    expect(sel.includeCompleted).toBe(true);
  });
  it("decodes a github source config", () => {
    const cfg = Schema.decodeUnknownSync(WorkflowSourceConfig)({
      id: "src-1",
      provider: "github",
      connectionRef: "conn-1",
      selector: { owner: "o", repo: "r" },
      destinationLane: "inbox",
      closedLane: "done",
      enabled: true,
    });
    expect(cfg.provider).toBe("github");
    expect(SourceId.is(cfg.id)).toBe(true);
  });
  it("rejects an unknown provider", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkflowSourceConfig)({
        id: "s",
        provider: "linear",
        connectionRef: "c",
        selector: {},
        destinationLane: "a",
        closedLane: "b",
        enabled: true,
      }),
    ).toThrow();
  });

  it("accepts jira as a valid provider", () => {
    const cfg = Schema.decodeUnknownSync(WorkflowSourceConfig)({
      id: "src-2",
      provider: "jira",
      connectionRef: "conn-2",
      selector: { projectKey: "ENG" },
      destinationLane: "inbox",
      closedLane: "done",
      enabled: true,
    });
    expect(cfg.provider).toBe("jira");
  });

  it("ImportableWorkItemView decodes a minimal Asana row (no displayRef, null mapping)", () => {
    const row = {
      provider: "asana", sourceId: "s", externalId: "task-gid-1", displayRef: "", title: "t",
      container: "111", url: "https://app.asana.com/0/111/task-gid-1", assignees: ["Jo"],
      lifecycle: "open", mappedTicketId: null, mappedLane: null,
    };
    const decoded = Schema.decodeUnknownSync(ImportableWorkItemView)(row);
    expect(decoded.externalId).toBe("task-gid-1");
    expect(decoded.mappedTicketId).toBe(null);
  });

  it("ListImportableWorkItemsResult decodes an empty result", () => {
    const decoded = Schema.decodeUnknownSync(ListImportableWorkItemsResult)({
      items: [], sources: [], viewer: {}, truncated: {}, sourceErrors: {},
    });
    expect(decoded.items).toEqual([]);
  });

  it("ImportWorkItemsResult decodes an empty result", () => {
    const decoded = Schema.decodeUnknownSync(ImportWorkItemsResult)({ imported: [], skipped: [] });
    expect(decoded.skipped).toEqual([]);
  });
});

describe("compileAutoPullRule", () => {
  it("labels any-of → or-of-in (single → bare in)", () => {
    assert.deepEqual(compileAutoPullRule({ labels: { mode: "any", values: ["XS", "S"] } }),
      { or: [ { in: ["XS", { var: "labels" }] }, { in: ["S", { var: "labels" }] } ] });
    assert.deepEqual(compileAutoPullRule({ labels: { mode: "any", values: ["XS"] } }),
      { in: ["XS", { var: "labels" }] });
  });
  it("labels all-of + state → and", () => {
    assert.deepEqual(compileAutoPullRule({ labels: { mode: "all", values: ["A", "B"] }, state: "open" }),
      { and: [ { and: [ { in: ["A", { var: "labels" }] }, { in: ["B", { var: "labels" }] } ] },
               { "==": [ { var: "state" }, "open" ] } ] });
  });
  it("assigned-to-anyone → bare var; specific → in; empty → ALWAYS", () => {
    assert.deepEqual(compileAutoPullRule({ assignee: { kind: "anyone" } }), { var: "assignees" });
    assert.deepEqual(compileAutoPullRule({ assignee: { kind: "login", value: "octocat" } }),
      { in: ["octocat", { var: "assignees" }] });
    assert.deepEqual(compileAutoPullRule({}), ALWAYS_RULE);
  });
});

describe("decodeAutoPullRule round-trips compiled criteria", () => {
  for (const c of [
    { labels: { mode: "any", values: ["XS"] } }, { labels: { mode: "all", values: ["A", "B"] } },
    { assignee: { kind: "anyone" } }, { assignee: { kind: "login", value: "x" } },
    { state: "open" }, { labels: { mode: "any", values: ["XS", "S"] }, state: "closed" }, {},
  ] as AutoPullCriteria[]) {
    it(`round-trips ${JSON.stringify(c)}`, () => assert.deepEqual(decodeAutoPullRule(compileAutoPullRule(c)), c));
  }
  it("returns null for an undecodable (raw/advanced) rule", () =>
    assert.equal(decodeAutoPullRule({ ">": [{ var: "title" }, 5] }), null));
});

describe("effectiveAutoPullRule", () => {
  const base = { id: "s", provider: "github", connectionRef: "c", selector: {}, destinationLane: "a", closedLane: "b" } as const;
  it("autoPull present → its rule; legacy enabled:true → ALWAYS; else null", () => {
    assert.deepEqual(effectiveAutoPullRule({ ...base, autoPull: { rule: { var: "assignees" } } }), { var: "assignees" });
    assert.deepEqual(effectiveAutoPullRule({ ...base, enabled: true }), ALWAYS_RULE);
    assert.equal(effectiveAutoPullRule({ ...base, enabled: false }), null);
    assert.equal(effectiveAutoPullRule({ ...base }), null);
  });
});

describe("JiraSelector", () => {
  it("decodes projectKey + optional jql", () => {
    const a = Schema.decodeUnknownSync(JiraSelector)({ projectKey: "ENG" });
    expect(a.projectKey).toBe("ENG");
    expect(a.jql).toBeUndefined();

    const b = Schema.decodeUnknownSync(JiraSelector)({
      projectKey: "ENG",
      jql: "labels = backend",
    });
    expect(b.jql).toBe("labels = backend");
  });

  it("rejects an empty projectKey", () => {
    expect(() => Schema.decodeUnknownSync(JiraSelector)({ projectKey: "" })).toThrow();
  });
});

describe("createWorkSourceConnection RPC payload", () => {
  // `provider: "github"` is a stand-in here: Task 3 adds "jira" to
  // WorkSourceProviderName, after which a Jira connection exercises the same
  // optional auth fields. These tests only need to prove the new optional
  // fields (authMode/baseUrl/email) decode, which any valid provider exercises.
  it("decodes optional auth fields (authMode/baseUrl/email)", () => {
    const decoded = Schema.decodeUnknownSync(WsWorkflowCreateWorkSourceConnectionRpc.payloadSchema)({
      provider: "github",
      displayName: "My Connection",
      token: "tok",
      authMode: "basic",
      baseUrl: "https://acme.atlassian.net",
      email: "me@acme.test",
    });
    expect(decoded.authMode).toBe("basic");
    expect(decoded.baseUrl).toBe("https://acme.atlassian.net");
    expect(decoded.email).toBe("me@acme.test");
  });

  it("rejects an invalid authMode", () => {
    expect(() =>
      Schema.decodeUnknownSync(WsWorkflowCreateWorkSourceConnectionRpc.payloadSchema)({
        provider: "github",
        displayName: "X",
        token: "t",
        authMode: "oauth",
      }),
    ).toThrow();
  });
});
