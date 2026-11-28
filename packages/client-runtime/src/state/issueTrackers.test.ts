import {
  IssueTrackerAccountId,
  IssueTrackerKind,
  MAX_ISSUE_TRACKER_ADDITIONAL_SCOPES,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boundIssueTrackerScopes,
  issueTrackerBindingFor,
  issueTrackerScopeOptions,
} from "./issueTrackers.ts";

describe("issueTrackerScopeOptions", () => {
  it("offers no new team once the binding is full, and keeps bound ones removable", () => {
    const tracker = {
      tracker: IssueTrackerKind.make("linear"),
      displayName: "Linear",
      host: "linear.app",
      scopeNoun: "team",
      credential: { label: "Personal API key", helpUrl: null },
      connected: true,
      account: "demo",
      detail: null,
      scopes: [
        { key: "ENG", name: "Engineering" },
        { key: "OPS", name: "Operations" },
      ],
    };
    const full = [
      "ENG",
      ...Array.from({ length: MAX_ISSUE_TRACKER_ADDITIONAL_SCOPES }, (_, i) => `T${i}`),
    ];
    const options = issueTrackerScopeOptions(tracker, full);
    expect(options.find((scope) => scope.key === "OPS")?.addable).toBe(false);
    expect(options.find((scope) => scope.key === "ENG")?.addable).toBe(true);
    expect(options.find((scope) => scope.key === "T0")).toEqual({
      key: "T0",
      name: "T0",
      addable: true,
    });
    expect(issueTrackerScopeOptions(tracker, ["ENG"]).every((scope) => scope.addable)).toBe(true);
  });
});

describe("boundIssueTrackerScopes", () => {
  it("keeps each account's teams apart, and binds new picks with that account", () => {
    const tracker = IssueTrackerKind.make("linear");
    const second = { tracker, accountId: IssueTrackerAccountId.make("second") };
    const binding = issueTrackerBindingFor(second, [], ["ENG", "OPS"]) ?? undefined;
    expect(binding).toEqual({ ...second, scope: "ENG", additionalScopes: ["OPS"] });
    expect(boundIssueTrackerScopes(second, binding)).toEqual(["ENG", "OPS"]);
    expect(boundIssueTrackerScopes({ tracker }, binding)).toEqual([]);
  });
});
