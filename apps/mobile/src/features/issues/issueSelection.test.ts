import { describe, expect, it } from "vite-plus/test";
import type { NavigationState } from "@react-navigation/native";
import { issueParamsKey, selectedIssueKey, type IssueParams } from "./issueSelection";

const params = {
  environmentId: "environment-one",
  projectId: "project-one",
  tracker: "linear",
  host: "Linear.APP",
  scope: "ENG",
  key: "ENG-7",
};
const home = { key: "home", name: "Home" };
const issue = { key: "issue", name: "Issue", params };
function selection(routes: NavigationState["routes"], index = routes.length - 1) {
  return selectedIssueKey({ routes, index });
}

describe("displayed issue selection", () => {
  it.each([
    ["tracker", "GitHub"],
    ["environmentId", " "],
    ["projectId", " "],
  ])("ignores an issue route with invalid %s", (field, value) => {
    expect(selection([home, { ...issue, params: { ...params, [field]: value } }])).toBeNull();
    expect(() => issueParamsKey({ ...params, [field]: value })).toThrow();
  });

  it.each([
    ["linear", "eng-7", "ENG-7"],
    ["jira", "eng-7", "ENG-7"],
    ["github", "Case-Sensitive", "Case-Sensitive"],
    ["custom-tracker", "Case-Sensitive", "Case-Sensitive"],
  ])("keeps native key rules for %s", (tracker, key, expectedKey) => {
    expect(selection([home, { ...issue, params: { ...params, tracker, key } }])).toBe(
      `environment-one:project-one\u0000${tracker}\u0000linear.app\u0000eng\u0000${expectedKey}`,
    );
  });

  it.each([undefined, {}, { ...params, tracker: 7 }])(
    "ignores missing or mistyped issue params: %j",
    (invalidParams) => {
      expect(selection([home, { ...issue, params: invalidParams }])).toBeNull();
    },
  );

  it("matches the list row key for the same environment and keeps environments and trackers apart", () => {
    expect(selection([home, issue])).toBe(issueParamsKey({ ...params, host: "linear.app" }));
    expect(selection([home, { ...issue, params: { ...params, tracker: "jira" } }])).not.toBe(
      selection([home, issue]),
    );
    expect(
      selection([home, { ...issue, params: { ...params, environmentId: "environment-two" } }]),
    ).not.toBe(selection([home, issue]));
  });

  it("follows the issue beneath its sheets and drops it beneath a later thread", () => {
    expect(selection([home, issue, { key: "compose", name: "IssueCompose", params }])).toBe(
      selection([home, issue]),
    );
    expect(selection([home, issue, { key: "thread", name: "Thread" }])).toBeNull();
    expect(selection([home, issue, { key: "pr", name: "PullRequest" }])).toBeNull();
    expect(selection([home, issue], 0)).toBeNull();
    expect(selection([])).toBeNull();
  });
});

it("selects only the exact Forgejo mount while accepting repository case aliases", () => {
  const native = {
    ...params,
    tracker: "forgejo",
    host: "forgejo.test",
    scope: "Mount/Acme/Web",
    key: "42",
  };
  const selected = selection([home, { ...issue, params: native }]);
  expect(selected).toBe(issueParamsKey({ ...native, scope: "Mount/acme/web" }));
  expect(selected).not.toBe(issueParamsKey({ ...native, scope: "mount/Acme/Web" }));
});

it("keeps the issue selection when an original URL is carried for fallback", () => {
  const linked: IssueParams = { ...params, originalURL: "https://linear.app/acme/issue/ENG-7" };
  expect(issueParamsKey(linked)).toBe(issueParamsKey(params));
  expect(selection([home, { ...issue, params: linked }])).toBe(selection([home, issue]));
});
